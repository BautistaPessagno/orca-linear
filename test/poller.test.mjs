import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPoller } from '../src/poller.mjs'
import { fakeSettings, fakeStorage } from './fakes.mjs'
import { issue } from './fixtures.mjs'

function setup(settings = {}) {
  const calls = []
  const host = { call: async (method, params) => (calls.push([method, params]), { ok: true }) }
  const storage = fakeStorage()
  const poller = createPoller({ store: { cached: async () => null, refresh: async () => null }, host, settings: fakeSettings(settings), storage, setTimer: () => null, clearTimer: () => {} })
  return { poller, calls, storage }
}

const started = (key, extra = {}) => issue({ key, state: { type: 'started', name: 'In Progress' }, ...extra })

test('updates the status bar from my issues, hiding it when idle', async () => {
  const { poller, calls } = setup()
  await poller.onMine([started('ENG-1'), started('ENG-2', { priority: 1 })])
  assert.deepEqual(calls[0], ['statusBar.update', { id: 'linear', visible: true, text: '2 in progress · 1 urgent', icon: 'activity', tone: 'warning', tooltip: 'Linear: 2 issues in progress, 1 urgent issue open' }])
  await poller.onMine([started('ENG-1'), started('ENG-2', { priority: 1 })])
  assert.equal(calls.filter((c) => c[0] === 'statusBar.update').length, 1)
  await poller.onMine([])
  assert.deepEqual(calls.at(-1), ['statusBar.update', { id: 'linear', visible: false }])
})

test('notifies new assignments only when asked, never on the first poll', async () => {
  const { poller, calls } = setup({ notifyAssigned: true })
  await poller.onMine([started('ENG-1')])
  assert.equal(calls.filter((c) => c[0] === 'notifications.show').length, 0)
  await poller.onMine([started('ENG-1'), started('ENG-2', { title: 'Made-up new work' })])
  assert.deepEqual(calls.filter((c) => c[0] === 'notifications.show').map((c) => c[1]), [{ title: 'Assigned to you: ENG-2', body: 'Made-up new work' }])
})

test('stays quiet with the setting off', async () => {
  const { poller, calls } = setup()
  await poller.onMine([started('ENG-1')])
  await poller.onMine([started('ENG-1'), started('ENG-2')])
  assert.equal(calls.filter((c) => c[0] === 'notifications.show').length, 0)
})
