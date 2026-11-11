import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBackendSelector } from '../src/select-backend.mjs'
import { fakeSettings } from './fakes.mjs'
import { issue, WS_ACME, WS_HOME } from './fixtures.mjs'

function fakeBackend(id, { workspaces, issues = [], fail } = {}) {
  const calls = []
  return {
    id,
    calls,
    workspaces: async () => workspaces,
    teams: async (ws) => (calls.push(['teams', ws]), [{ id: `${id}-team`, workspaceId: ws === 'all' ? WS_ACME.id : ws }]),
    projects: async (ws) => [],
    listIssues: async (ws, q) => {
      calls.push(['list', ws, q.view])
      if (fail) throw Object.assign(new Error(fail), { kind: 'error' })
      return { issues: issues.filter((i) => ws === 'all' || i.workspace.id === ws), partial: false, errors: [] }
    },
    issue: async (ws, key) => (calls.push(['issue', ws, key]), { from: id }),
    update: async (ws) => calls.push(['update', ws])
  }
}

const keysWith = (...ids) => ({ list: async () => ids.map((id) => ({ id, name: id })) })

test('auto: the API serves keyed workspaces, the CLI the rest', async () => {
  const both = [issue({ key: 'A-1', workspace: WS_ACME }), issue({ key: 'H-1', workspace: WS_HOME })]
  const cli = fakeBackend('cli', { workspaces: [WS_ACME, WS_HOME], issues: both })
  const api = fakeBackend('api', { workspaces: [WS_HOME], issues: [issue({ key: 'H-1', workspace: WS_HOME, title: 'from api' })] })
  const selector = createBackendSelector({ cli, api, keys: keysWith(WS_HOME.id), settings: fakeSettings() })
  const { workspaces } = await selector.workspaces()
  assert.deepEqual(workspaces.map((w) => [w.id, w.backend, w.cycles]), [['ws-acme', 'cli', false], ['ws-home', 'api', true]])
  const all = await selector.listIssues('all', { view: 'mine' })
  assert.deepEqual(all.issues.map((i) => [i.key, i.title]).sort(), [['A-1', 'Made-up issue A-1'], ['H-1', 'from api']])
  await selector.issue(WS_HOME.id, 'H-1')
  await selector.issue(WS_ACME.id, 'A-1')
  assert.deepEqual(api.calls.at(-1), ['issue', 'ws-home', 'H-1'])
  assert.deepEqual(cli.calls.at(-1), ['issue', 'ws-acme', 'A-1'])
})

test('cli mode ignores keys; api mode refuses workspaces without one', async () => {
  const cli = fakeBackend('cli', { workspaces: [WS_ACME] })
  const api = fakeBackend('api', { workspaces: [WS_HOME] })
  const settings = fakeSettings({ backend: 'cli' })
  const selector = createBackendSelector({ cli, api, keys: keysWith(WS_HOME.id), settings })
  assert.equal(await selector.backendFor(WS_HOME.id), 'cli')
  settings.values.backend = 'api'
  await assert.rejects(selector.issue(WS_ACME.id, 'A-1'), (e) => e.kind === 'not-connected')
  assert.deepEqual((await selector.workspaces()).workspaces.map((w) => w.id), ['ws-home'])
})

test('the current cycle across workspaces asks only the API', async () => {
  const cli = fakeBackend('cli', { workspaces: [WS_ACME] })
  const api = fakeBackend('api', { workspaces: [WS_HOME], issues: [issue({ workspace: WS_HOME })] })
  const result = await createBackendSelector({ cli, api, keys: keysWith(WS_HOME.id), settings: fakeSettings() }).listIssues('all', { view: 'cycle' })
  assert.equal(result.issues.length, 1)
  assert.equal(cli.calls.length, 0)
  await assert.rejects(createBackendSelector({ cli, api, keys: keysWith(), settings: fakeSettings() }).listIssues('all', { view: 'cycle' }), (e) => e.kind === 'unsupported')
})

test('one failing share becomes an error line', async () => {
  const cli = fakeBackend('cli', { workspaces: [WS_ACME], fail: 'CLI broke' })
  const api = fakeBackend('api', { workspaces: [WS_HOME], issues: [issue({ workspace: WS_HOME })] })
  const result = await createBackendSelector({ cli, api, keys: keysWith(WS_HOME.id), settings: fakeSettings() }).listIssues('all', { view: 'mine' })
  assert.equal(result.issues.length, 1)
  assert.deepEqual(result.errors, ['CLI broke'])
})

test('a missing CLI still lists API workspaces', async () => {
  const cli = { ...fakeBackend('cli'), workspaces: async () => { throw Object.assign(new Error('no orca'), { kind: 'no-cli' }) } }
  const api = fakeBackend('api', { workspaces: [WS_HOME] })
  const out = await createBackendSelector({ cli, api, keys: keysWith(WS_HOME.id), settings: fakeSettings() }).workspaces()
  assert.deepEqual(out.workspaces.map((w) => w.id), ['ws-home'])
  assert.equal(out.errors.length, 1)
})
