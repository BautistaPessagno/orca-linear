// Linear Issues worker: the handlers the sidebar panel calls, the cache behind them, and the
// poller behind the status bar item. Linear is reached through Orca's own connection (the `orca
// linear` CLI) or, for a workspace with a pasted API key, Linear's GraphQL API.
import { existsSync, readFileSync } from 'node:fs'
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

// Made-up data for screenshots, only while the git-ignored .scratch/fixtures.json exists.
const FIXTURES = new URL('./.scratch/fixtures.json', import.meta.url)
function fixtureConfig() {
  try {
    return existsSync(FIXTURES) ? JSON.parse(readFileSync(FIXTURES, 'utf8')) : null
  } catch {
    return null
  }
}

function prefixed(storage, prefix) {
  return {
    get: (key) => storage.get(prefix + key),
    set: (key, value) => storage.set(prefix + key, value),
    delete: (key) => storage.delete(prefix + key)
  }
}

// A selector whose methods wait for the fixture module.
function fixtureSelector(config) {
  const loading = import('./scripts/fixture-backend.mjs').then((m) => m.createFixtureSelector({ config }))
  return new Proxy({}, { get: (_, name) => async (...args) => (await loading)[name](...args) })
}

export default function activate(orca, deps = {}) {
  const log = (message) => orca.log?.(message)
  const setting = async (key) => Promise.resolve(orca.settings.get(key)).catch(() => undefined)

  const run = deps.run ?? createCliRunner({ locate: async () => locateOrca({ setting: await setting('orcaPath') }) })
  const gql = deps.gql ?? createGraphqlClient()
  const fixtures = deps.fixtures !== undefined ? deps.fixtures : fixtureConfig()
  // Fixture mode keeps its cache apart, so a screenshot never shows a cached real list.
  const storage = fixtures ? prefixed(orca.storage, 'fixtures:') : orca.storage
  let keys = createApiKeys({ secrets: orca.secrets, storage, gql })
  let completedDays = 14
  let selector = createBackendSelector({
    cli: createCliBackend({ run }),
    api: createApiBackend({ keys, gql, completedDays: () => completedDays }),
    keys,
    settings: orca.settings
  })
  let host = orca.host
  if (fixtures) {
    log('using made-up fixture data (.scratch/fixtures.json)')
    selector = fixtureSelector(fixtures)
    keys = { list: async () => selector.keys(), add: async () => ({ id: 'ws-side', name: 'side-project' }), remove: async () => {} }
    host = {
      call: async (method, params) =>
        method === 'workspace.readContext' && fixtures.focusBranch ? { branch: fixtures.focusBranch, displayName: 'eng-142', terminals: [] } : orca.host.call(method, params)
    }
  }

  const post = (event, payload) => {
    try {
      orca.panels.post(event, payload)
    } catch (error) {
      log(`post: ${error.message}`)
    }
  }

  const mineKey = listKey(MINE)
  const store = createIssueStore({
    storage,
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

  poller = createPoller({ store, host: orca.host, settings: orca.settings, storage, log })

  const handlers = createPanelHandlers({
    selector,
    store,
    keys,
    avatars: deps.avatars ?? createAvatars(),
    startWork: createStartWork({ host, run }),
    host,
    dev: fixtures?.route ?? null
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
