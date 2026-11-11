import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStartWork } from '../src/start-work.mjs'

const WORKSPACES = [
  { id: 'w1', kind: 'worktree', name: 'app', project: 'app', path: '/repos/app', branch: 'main', hostId: null },
  { id: 'w2', kind: 'worktree', name: 'eng-5', project: 'app', path: '/repos/app-eng-5', branch: 'refs/heads/pat/eng-5-made-up', hostId: null },
  { id: 'w3', kind: 'folder', name: 'notes', project: null, path: '/notes', branch: null, hostId: null }
]

function setup(context = { branch: 'main', displayName: 'app' }) {
  const calls = []
  const runs = []
  const host = {
    call: async (method, params) => {
      calls.push([method, params])
      if (method === 'workspace.list') return { workspaces: WORKSPACES, truncated: false }
      if (method === 'workspace.readContext') return context
      return { opened: true }
    }
  }
  const run = async (args, options) => (runs.push({ args, options }), { worktree: { name: 'eng-9' } })
  return { work: createStartWork({ host, run }), calls, runs }
}

test('finds the workspace already on the issue', async () => {
  const { work } = setup()
  const found = await work.find({ key: 'ENG-5', branchName: 'pat/eng-5-made-up' })
  assert.deepEqual(found.workspaces.map((w) => w.id), ['w2'])
  assert.equal(found.canCreate, true)
  assert.equal((await work.find({ key: 'ENG-50' })).workspaces.length, 0)
})

test('start opens an existing workspace instead of making one', async () => {
  const { work, calls, runs } = setup()
  assert.deepEqual(await work.start({ key: 'ENG-5' }), { opened: true, created: false, workspace: 'eng-5' })
  assert.deepEqual(calls.at(-1), ['workspace.open', { workspaceId: 'w2' }])
  assert.equal(runs.length, 0)
})

test('start makes a worktree from the focused workspace’s repository (fake CLI)', async () => {
  const { work, runs } = setup()
  const result = await work.start({ key: 'ENG-9', branchName: 'pat/eng-9-made-up' })
  assert.equal(result.created, true)
  assert.deepEqual(runs[0].args, ['worktree', 'create', '--name', 'eng-9', '--linear-issue', 'ENG-9', '--no-parent', '--activate', '--branch', 'pat/eng-9-made-up'])
  assert.equal(runs[0].options.cwd, '/repos/app')
})

test('needs a focused worktree, and a sane branch name', async () => {
  await assert.rejects(setup(null).work.start({ key: 'ENG-9' }), (e) => e.kind === 'invalid')
  await assert.rejects(setup({ branch: 'nope', displayName: 'notes' }).work.start({ key: 'ENG-9' }), (e) => e.kind === 'invalid')
  await assert.rejects(setup().work.start({ key: 'ENG-9', branchName: '--force' }), (e) => e.kind === 'invalid')
  await assert.rejects(setup().work.start({ key: 'ENG-9', branchName: 'a/../b' }), (e) => e.kind === 'invalid')
})

test('opens only workspaces that exist', async () => {
  const { work } = setup()
  await assert.rejects(work.open({ workspaceId: 'gone' }), (e) => e.kind === 'invalid')
  assert.deepEqual(await work.open({ workspaceId: 'w1' }), { opened: true })
})
