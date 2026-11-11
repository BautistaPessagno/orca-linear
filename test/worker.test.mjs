import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import activate, { deactivate } from '../worker.mjs'
import { fakeSecrets, fakeSettings, fakeStorage } from './fakes.mjs'
import { cliRow } from './fixtures.mjs'

const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))

function fakeOrca() {
  const handlers = new Map()
  const calls = []
  const orca = {
    panels: { handle: (name, fn) => (handlers.set(name, fn), { dispose() {} }), post: (event, payload) => calls.push(['post', event, payload]) },
    settings: fakeSettings(),
    secrets: fakeSecrets(),
    storage: fakeStorage(),
    host: { call: async (method, params) => (calls.push([method, params]), method === 'workspace.readContext' ? null : { ok: true }) },
    log: () => {}
  }
  return { orca, handlers, calls }
}

// The CLI answered with made-up data; no process runs.
const run = async (args) => {
  if (args[1] === 'team') return { teams: [{ id: 'team-eng', key: 'ENG', name: 'Engineering', workspace: { id: 'ws-acme', name: 'acme' } }] }
  if (args[1] === 'list-issues') return { issues: [cliRow(), cliRow({ identifier: 'ENG-2', priority: 1 })], meta: {} }
  return {}
}

test('answers every panel request', () => {
  const { orca, handlers } = fakeOrca()
  activate(orca, { run, poll: false })
  deactivate()
  assert.deepEqual([...handlers.keys()].sort(), [
    'app.state', 'avatar', 'focus.get', 'issue.comment', 'issue.get', 'issue.update', 'issues.list', 'issues.search',
    'keys.add', 'keys.remove', 'projects.list', 'team.meta', 'teams.list', 'work.find', 'work.open', 'work.start'
  ])
})

test('a fresh My issues list updates the status bar', async () => {
  const { orca, handlers, calls } = fakeOrca()
  activate(orca, { run, poll: false })
  await handlers.get('issues.list')({ view: 'mine', workspace: 'all' })
  await new Promise((r) => setImmediate(r))
  deactivate()
  const update = calls.find((c) => c[0] === 'statusBar.update')
  assert.equal(update[1].text, '2 in progress · 1 urgent')
})

test('the manifest: panel, status bar item, settings and access', () => {
  assert.equal(manifest.publisher, undefined)
  assert.equal(manifest.id.startsWith('orca-'), false)
  assert.match(manifest.description, /Not affiliated with Linear/)
  assert.deepEqual(manifest.contributes.panels.map((p) => p.entry), ['panel/index.html'])
  assert.deepEqual(manifest.contributes.statusBarItems.map((i) => i.id), ['linear'])
  assert.deepEqual(manifest.capabilities.map((c) => c.kind).sort(), ['notifications:show', 'secrets:own', 'settings:own', 'storage:own', 'workspace:read', 'workspace:write'])
  const settings = Object.fromEntries(manifest.contributes.settings.map((s) => [s.key, s]))
  assert.deepEqual(settings.backend.enum, ['auto', 'cli', 'api'])
  assert.equal(settings.notifyAssigned.default, false)
  assert.equal(settings.refreshMinutes.default, 5)
})
