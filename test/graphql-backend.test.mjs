import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApiBackend, createApiKeys, createGraphqlClient, viewFilter } from '../backends/graphql.mjs'
import { fakeLinearApi, fakeSecrets, fakeStorage, reply } from './fakes.mjs'

const KEY = 'lin_api_' + 'a'.repeat(40)
const NOW = Date.parse('2026-03-10T00:00:00Z')

const node = (over = {}) => ({
  id: 'i1', identifier: 'ENG-1', title: 'Made-up', url: 'https://linear.app/acme/issue/ENG-1', priority: 2, estimate: 2, dueDate: null, branchName: 'pat/eng-1',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z', state: { id: 's1', name: 'In Progress', type: 'started', color: '#f2c94c' },
  team: { id: 'team-eng', key: 'ENG', name: 'Engineering', color: '#5e6ad2' }, project: null,
  cycle: { id: 'c1', number: 12, name: null, startsAt: '2026-03-02T00:00:00Z', endsAt: '2026-03-16T00:00:00Z' },
  assignee: { id: 'u1', displayName: 'Pat', avatarUrl: null }, labels: { nodes: [{ id: 'l1', name: 'Bug', color: '#f00' }] }, ...over
})

function setup(answer) {
  const api = fakeLinearApi(answer)
  const gql = createGraphqlClient({ fetchImpl: api.fetchImpl })
  const keys = { list: async () => [{ id: 'ws-acme', name: 'acme' }], get: async (ws) => (ws === 'ws-acme' ? KEY : null) }
  return { api, backend: createApiBackend({ keys, gql, now: () => NOW }) }
}

test('sends the key without Bearer and reads data', async () => {
  const { api, backend } = setup(() => ({ data: { issues: { nodes: [node()], pageInfo: { hasNextPage: false } } } }))
  const result = await backend.listIssues('ws-acme', { view: 'mine' })
  assert.equal(api.requests[0].url, 'https://api.linear.app/graphql')
  assert.equal(api.requests[0].key, KEY)
  assert.deepEqual(result.issues[0].cycle, { id: 'c1', number: 12, name: null, startsAt: '2026-03-02T00:00:00Z', endsAt: '2026-03-16T00:00:00Z' })
  assert.deepEqual(result.issues[0].workspace, { id: 'ws-acme', name: 'acme' })
  assert.equal(result.issues[0].labels[0].name, 'Bug')
})

test('view filters', () => {
  assert.deepEqual(viewFilter({ view: 'cycle', team: 'team-eng' }), { team: { id: { eq: 'team-eng' } }, cycle: { isActive: { eq: true } } })
  assert.deepEqual(viewFilter({ view: 'backlog' }), { state: { type: { eq: 'backlog' } } })
  const mine = viewFilter({ view: 'mine', project: 'p1' }, { now: NOW, completedDays: 7 })
  assert.deepEqual(mine.assignee, { isMe: { eq: true } })
  assert.deepEqual(mine.project, { id: { eq: 'p1' } })
  assert.equal(mine.or[1].updatedAt.gt, '2026-03-03T00:00:00.000Z')
  assert.deepEqual(viewFilter({ view: 'created' }).creator, { isMe: { eq: true } })
  assert.throws(() => viewFilter({ view: 'nope' }), (e) => e.kind === 'invalid')
  assert.throws(() => viewFilter({ view: 'mine', team: '{"x":1}' }), (e) => e.kind === 'invalid')
})

test('follows pages', async () => {
  let page = 0
  const { api, backend } = setup(() => (page++ === 0 ? { data: { issues: { nodes: [node()], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } } : { data: { issues: { nodes: [node({ id: 'i2', identifier: 'ENG-2' })], pageInfo: { hasNextPage: false } } } }))
  const result = await backend.listIssues('ws-acme', { view: 'backlog' })
  assert.deepEqual(result.issues.map((i) => i.key), ['ENG-1', 'ENG-2'])
  assert.equal(api.requests[1].variables.after, 'c1')
})

test('maps rate limits, refused keys and GraphQL errors', async () => {
  let out
  const { backend } = setup(() => out)
  out = reply(429, { errors: [{ message: 'slow down', extensions: { code: 'RATELIMITED' } }] }, { 'retry-after': '30' })
  await assert.rejects(backend.listIssues('ws-acme', { view: 'mine' }), (e) => e.kind === 'rate-limited' && e.retryAfterMs === 30_000)
  out = reply(400, { errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] })
  await assert.rejects(backend.listIssues('ws-acme', { view: 'mine' }), (e) => e.kind === 'unauthenticated')
  out = { errors: [{ message: 'Entity not found: Issue' }], data: null }
  await assert.rejects(backend.issue('ws-acme', 'ENG-404'), (e) => e.kind === 'not-found')
  await assert.rejects(backend.listIssues('ws-other', { view: 'mine' }), (e) => e.kind === 'not-connected')
})

test('reads an issue with relations from both sides', async () => {
  const { backend } = setup(() => ({
    data: {
      issue: {
        ...node(), description: 'Made-up body',
        children: { nodes: [node({ id: 'i3', identifier: 'ENG-3' })], pageInfo: { hasNextPage: false } },
        relations: { nodes: [{ id: 'r1', type: 'blocks', relatedIssue: { id: 'i9', identifier: 'ENG-9', title: 'X', url: 'u' } }] },
        inverseRelations: { nodes: [{ id: 'r2', type: 'blocks', issue: { id: 'i8', identifier: 'ENG-8', title: 'Y', url: 'v' } }, { id: 'r3', type: 'duplicate', issue: { id: 'i7', identifier: 'ENG-7', title: 'Z', url: 'w' } }] },
        comments: { nodes: [{ id: 'c2', body: 'second', createdAt: '2026-03-02T00:00:00Z', parent: { id: 'c1' }, user: null }, { id: 'c1', body: 'first', createdAt: '2026-03-01T00:00:00Z', parent: null, user: { id: 'u1', displayName: 'Pat', avatarUrl: null } }], pageInfo: { hasNextPage: false } },
        attachments: { nodes: [{ id: 'a1', title: 'PR', subtitle: null, url: 'https://github.com/x/y/pull/1', sourceType: 'github', createdAt: '2026-03-01T00:00:00Z' }] }
      }
    }
  }))
  const detail = await backend.issue('ws-acme', 'ENG-1')
  assert.equal(detail.issue.description, 'Made-up body')
  assert.deepEqual(detail.relations.map((r) => [r.kind, r.issue.key]), [['blocks', 'ENG-9'], ['blockedBy', 'ENG-8'], ['duplicatedBy', 'ENG-7']])
  assert.deepEqual(detail.comments.map((c) => c.id), ['c1', 'c2'])
  assert.equal(detail.comments[1].parentId, 'c1')
  assert.equal(detail.children[0].key, 'ENG-3')
})

test('writes go through issueUpdate and commentCreate (fake API only)', async () => {
  const { api, backend } = setup(({ query }) => {
    if (query.includes('viewer')) return { data: { viewer: { id: 'u-me' } } }
    if (query.includes('issueUpdate')) return { data: { issueUpdate: { success: true } } }
    if (query.includes('commentCreate')) return { data: { commentCreate: { success: true } } }
    return { data: { issue: { id: 'uuid-1' } } }
  })
  await backend.update('ws-acme', 'ENG-1', { state: { id: 's2', name: 'Done' } })
  await backend.update('ws-acme', 'ENG-1', { priority: 4 })
  await backend.update('ws-acme', 'ENG-1', { assignee: 'me' })
  await backend.update('ws-acme', 'ENG-1', { assignee: null })
  await backend.comment('ws-acme', 'ENG-1', 'Made-up comment')
  const updates = api.requests.filter((r) => r.query.includes('issueUpdate')).map((r) => r.variables.input)
  assert.deepEqual(updates, [{ stateId: 's2' }, { priority: 4 }, { assigneeId: 'u-me' }, { assigneeId: null }])
  assert.deepEqual(api.requests.at(-1).variables.input, { issueId: 'uuid-1', body: 'Made-up comment' })
})

test('teams carry triage and the active cycle', async () => {
  const { backend } = setup(() => ({ data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Eng', color: null, triageEnabled: true, activeCycle: { id: 'c1', number: 4 } }] } } }))
  const [team] = await backend.teams('ws-acme')
  assert.equal(team.triage, true)
  assert.equal(team.activeCycle.number, 4)
  assert.equal(team.workspaceId, 'ws-acme')
})

test('API keys: checked against Linear, stored per workspace in secrets', async () => {
  const secrets = fakeSecrets()
  const storage = fakeStorage()
  const api = fakeLinearApi(() => ({ data: { viewer: { id: 'u1' }, organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' } } }))
  const keys = createApiKeys({ secrets, storage, gql: createGraphqlClient({ fetchImpl: api.fetchImpl }) })
  await assert.rejects(keys.add('not-a-key'), (e) => e.kind === 'invalid')
  assert.equal(api.requests.length, 0)
  assert.deepEqual(await keys.add(`  ${KEY} `), { id: 'org-1', name: 'acme' })
  assert.equal(secrets.values['apiKey:org-1'], KEY)
  assert.deepEqual(storage.values.apiWorkspaces, [{ id: 'org-1', name: 'acme', urlKey: 'acme' }])
  assert.equal(JSON.stringify(storage.values).includes(KEY), false)
  await keys.remove('org-1')
  assert.equal(secrets.values['apiKey:org-1'], undefined)
  assert.deepEqual(await keys.list(), [])
})
