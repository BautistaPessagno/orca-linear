import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIssueStore, listKey } from '../src/store.mjs'
import { fakeStorage } from './fakes.mjs'
import { issue } from './fixtures.mjs'

const params = { view: 'mine', workspace: 'all' }

function setup() {
  let t = 1000
  const storage = fakeStorage()
  const posts = []
  const fetches = []
  let answer = [issue({ key: 'ENG-1' })]
  const store = createIssueStore({
    storage,
    now: () => t,
    post: (event, payload) => posts.push([event, payload]),
    fetchList: async (p) => (fetches.push(p), { issues: answer, partial: false, errors: [] })
  })
  return { store, storage, posts, fetches, tick: (ms) => (t += ms), set: (list) => (answer = list) }
}

test('a cold list waits for the backend and caches it', async () => {
  const { store, storage, fetches } = setup()
  const result = await store.list(params)
  assert.equal(result.stale, false)
  assert.equal(result.issues[0].key, 'ENG-1')
  assert.equal(fetches.length, 1)
  assert.ok(storage.values['cache:' + listKey(params)])
})

test('a cached list answers at once, refreshes behind, then tells the panel', async () => {
  const { store, posts, set, tick } = setup()
  await store.list(params)
  tick(60_000)
  set([issue({ key: 'ENG-2' })])
  const cached = await store.list(params)
  assert.equal(cached.stale, true)
  assert.equal(cached.issues[0].key, 'ENG-1')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(posts, [['issues.changed', { key: listKey(params) }]])
  assert.equal((await store.list(params)).issues[0].key, 'ENG-2')
})

test('does not refetch a list fetched seconds ago, and shares one refresh', async () => {
  const { store, fetches } = setup()
  await store.list(params)
  const again = await store.list(params)
  assert.equal(again.stale, false)
  assert.equal(fetches.length, 1)
  await Promise.all([store.refresh(params, { force: true }), store.refresh(params, { force: true })])
  assert.equal(fetches.length, 2)
})

test('keeps the most recent lists only', async () => {
  const { store, storage } = setup()
  for (let i = 0; i < 30; i++) await store.list({ view: 'search', workspace: 'all', project: `p${i}` })
  assert.equal(storage.values['cache:index'].length, 24)
  assert.equal(Object.keys(storage.values).filter((k) => k.startsWith('cache:') && k !== 'cache:index').length, 24)
})

test('invalidate makes the next ask refresh and tells panels', async () => {
  const { store, posts, fetches } = setup()
  await store.list(params)
  store.invalidate()
  assert.deepEqual(posts.at(-1), ['issues.changed', { key: '*' }])
  const result = await store.list(params)
  assert.equal(result.stale, true)
  await new Promise((r) => setImmediate(r))
  assert.equal(fetches.length, 2)
})
