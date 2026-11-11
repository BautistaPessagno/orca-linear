// Linear Issues worker: the handlers the sidebar panel calls, the cache behind them, and the
// poller behind the status bar item. Linear is reached through Orca's own connection (the `orca
// linear` CLI) or, for a workspace with a pasted API key, Linear's GraphQL API.
import { createApiBackend, createApiKeys, createGraphqlClient } from './backends/graphql.mjs'
import { createCliBackend, createCliRunner } from './backends/cli.mjs'
import { createAvatars } from './src/avatars.mjs'
import { locateOrca } from './src/locate-orca.mjs'
import { createPanelHandlers } from './src/panel-protocol.mjs'
import { MINE, createPoller } from './src/poller.mjs'
import { createBackendSelector } from './src/select-backend.mjs'
import { createStartWork } from './src/start-work.mjs'
import { listKey, createIssueStore } from './src/store.mjs'

let poller = null

export default function activate(orca, deps = {}) {
  const log = (message) => orca.log?.(message)
  const setting = async (key) => Promise.resolve(orca.settings.get(key)).catch(() => undefined)

  const run = deps.run ?? createCliRunner({ locate: async () => locateOrca({ setting: await setting('orcaPath') }) })
  const gql = deps.gql ?? createGraphqlClient()
  const keys = createApiKeys({ secrets: orca.secrets, storage: orca.storage, gql })
  let completedDays = 14
  const selector = createBackendSelector({
    cli: createCliBackend({ run }),
    api: createApiBackend({ keys, gql, completedDays: () => completedDays }),
    keys,
    settings: orca.settings
  })

  const post = (event, payload) => {
    try {
      orca.panels.post(event, payload)
    } catch (error) {
      log(`post: ${error.message}`)
    }
  }

  const mineKey = listKey(MINE)
  const store = createIssueStore({
    storage: orca.storage,
    post,
    fetchList: async (params) => {
      const days = Number(await setting('completedDays'))
      completedDays = Number.isFinite(days) && days >= 1 && days <= 90 ? days : 14
      return selector.listIssues(params.workspace, params)
    },
    onFresh: (params, entry) => {
      if (listKey(params) === mineKey) void poller?.onMine(entry.issues)
    }
  })

  poller = createPoller({ store, host: orca.host, settings: orca.settings, storage: orca.storage, log })

  const handlers = createPanelHandlers({
    selector,
    store,
    keys,
    avatars: deps.avatars ?? createAvatars(),
    startWork: createStartWork({ host: orca.host, run }),
    host: orca.host
  })
  for (const [name, handler] of Object.entries(handlers)) orca.panels.handle(name, handler)

  // A different backend or path changes what every list holds.
  orca.settings.onDidChange?.(({ key } = {}) => {
    if (key === 'orcaPath') run.reset?.()
    if (key === 'backend' || key === 'orcaPath' || key === 'completedDays') store.invalidate()
  })

  if (deps.poll !== false) void poller.start()
}

export function deactivate() {
  poller?.stop()
}
