import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPanelHandlers } from '../src/panel-protocol.mjs'
import { createIssueStore } from '../src/store.mjs'
import { fakeStorage } from './fakes.mjs'
import { issue, WS_ACME } from './fixtures.mjs'

const META = {
  states: [{ id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 }, { id: 's-rev', name: 'In Review', type: 'started', position: 3 }],
  members: [{ id: 'user-sam', name: 'Sam', avatarUrl: 'https://public.linear.app/sam.png' }],
  labels: []
}

function setup({ context = { branch: 'pat/eng-12-made-up', displayName: 'eng-12', terminals: [] } } = {}) {
  const writes = []
  const posts = []
  const selector = {
    mode: async () => 'auto',
    workspaces: async () => ({ workspaces: [{ ...WS_ACME, backend: 'cli', cycles: false }], errors: [] }),
    teams: async () => [{ id: 'team-eng', key: 'ENG', workspaceId: 'ws-acme' }],
    projects: async () => [],
    listIssues: async (ws, q) => ({ issues: [issue({ key: 'ENG-1', assignee: { id: 'u', name: 'Pat', avatarUrl: 'https://public.linear.app/pat.png' } })], partial: false, errors: [] }),
    issue: async (ws, key) => ({ issue: issue({ key }), comments: [], children: [], relations: [], attachments: [] }),
    teamMeta: async () => META,
    update: async (ws, key, change) => writes.push(['update', ws, key, change]),
    comment: async (ws, key, body) => writes.push(['comment', ws, key, body])
  }
  const store = createIssueStore({ storage: fakeStorage(), fetchList: (p) => selector.listIssues(p.workspace, p), post: (e, p) => posts.push([e, p]) })
  const remembered = []
  const avatars = { remember: (v) => (remembered.push(v), v), get: async (url) => (url === 'https://public.linear.app/pat.png' ? 'data:image/png;base64,AA==' : null) }
  const keys = { list: async () => [], add: async (key) => ({ id: 'org', name: key }), remove: async () => {} }
  const host = { call: async (method) => (method === 'workspace.readContext' ? context : null) }
  const handlers = createPanelHandlers({ selector, store, keys, avatars, startWork: { find: async (i) => ({ asked: i }) }, host })
  return { handlers, writes, posts, remembered }
}

test('app.state names the workspaces, the mode and the focused issue', async () => {
  const { handlers } = setup()
  const state = await handlers['app.state']()
  assert.deepEqual(state.workspaces.map((w) => w.id), ['ws-acme'])
  assert.equal(state.mode, 'auto')
  assert.deepEqual(state.focus, { branch: 'pat/eng-12-made-up', name: 'eng-12', key: 'ENG-12' })
})

test('no focused workspace means no focused issue', async () => {
  const { handlers } = setup({ context: null })
  assert.equal(await handlers['focus.get'](), null)
})

test('issues.list goes through the cache and remembers avatars', async () => {
  const { handlers, remembered } = setup()
  const result = await handlers['issues.list']({ view: 'mine', workspace: 'all' })
  assert.equal(result.issues[0].key, 'ENG-1')
  assert.equal(result.stale, false)
  assert.equal(remembered.length, 1)
})

test('bad input comes back as an error the panel can show', async () => {
  const { handlers } = setup()
  assert.equal((await handlers['issues.list']({ view: 'everything' })).error.kind, 'invalid')
  assert.equal((await handlers['issues.list']({ view: 'mine', team: '../x' })).error.kind, 'invalid')
  assert.equal((await handlers['issue.get']({ workspace: 'all', key: 'ENG-1' })).error.kind, 'invalid')
  assert.equal((await handlers['issue.get']({ workspace: 'ws-acme', key: 'rm -rf' })).error.kind, 'invalid')
  assert.equal((await handlers['issues.search']({ text: '' })).error.kind, 'invalid')
})

test('status changes must name one of the team’s states', async () => {
  const { handlers, writes, posts } = setup()
  const refused = await handlers['issue.update']({ workspace: 'ws-acme', key: 'ENG-1', team: 'ENG', change: { state: 'Shipped' } })
  assert.equal(refused.error.kind, 'invalid')
  const after = await handlers['issue.update']({ workspace: 'ws-acme', key: 'ENG-1', team: 'ENG', change: { state: 'In Review' } })
  assert.equal(after.issue.key, 'ENG-1')
  assert.deepEqual(writes, [['update', 'ws-acme', 'ENG-1', { state: { id: 's-rev', name: 'In Review' } }]])
  assert.deepEqual(posts.at(-1), ['issues.changed', { key: '*' }])
})

test('priority 0–4 only; assignee me, nobody, or a team member', async () => {
  const { handlers, writes } = setup()
  const base = { workspace: 'ws-acme', key: 'ENG-1', team: 'ENG' }
  assert.equal((await handlers['issue.update']({ ...base, change: { priority: 7 } })).error.kind, 'invalid')
  assert.equal((await handlers['issue.update']({ ...base, change: { priority: 1, state: 'Todo' } })).error.kind, 'invalid')
  assert.equal((await handlers['issue.update']({ ...base, change: { assignee: 'user-stranger' } })).error.kind, 'invalid')
  await handlers['issue.update']({ ...base, change: { priority: 1 } })
  await handlers['issue.update']({ ...base, change: { assignee: 'me' } })
  await handlers['issue.update']({ ...base, change: { assignee: null } })
  await handlers['issue.update']({ ...base, change: { assignee: 'user-sam' } })
  assert.deepEqual(writes.map((w) => w[3]), [{ priority: 1 }, { assignee: 'me' }, { assignee: null }, { assignee: 'user-sam' }])
})

test('comments are trimmed, not empty and not huge', async () => {
  const { handlers, writes } = setup()
  assert.equal((await handlers['issue.comment']({ workspace: 'ws-acme', key: 'ENG-1', body: '   ' })).error.kind, 'invalid')
  assert.equal((await handlers['issue.comment']({ workspace: 'ws-acme', key: 'ENG-1', body: 'x'.repeat(10_001) })).error.kind, 'invalid')
  await handlers['issue.comment']({ workspace: 'ws-acme', key: 'ENG-1', body: '  Looks good\r\nShip it  ' })
  assert.deepEqual(writes, [['comment', 'ws-acme', 'ENG-1', 'Looks good\nShip it']])
})

test('a cached detail opens instantly', async () => {
  const { handlers } = setup()
  assert.equal((await handlers['issue.get']({ workspace: 'ws-acme', key: 'ENG-3', cached: true })).cached, undefined)
  assert.equal((await handlers['issue.get']({ workspace: 'ws-acme', key: 'ENG-3', cached: true })).cached, true)
})

test('avatars come back as data URLs', async () => {
  const { handlers } = setup()
  assert.deepEqual(await handlers.avatar({ url: 'https://public.linear.app/pat.png' }), { url: 'https://public.linear.app/pat.png', dataUrl: 'data:image/png;base64,AA==' })
})
