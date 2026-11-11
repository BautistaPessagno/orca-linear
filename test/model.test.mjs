import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dueState, groupIssues, keyFromBranch, sortIssues, statusBarView, matchesText, isOpen } from '../src/model.mjs'
import { issue } from './fixtures.mjs'

const NOW = Date.parse('2026-03-10T12:00:00Z')
const DAY = 86_400_000

test('sorts urgent first and no priority last, then most recently updated', () => {
  const list = [
    issue({ key: 'A-1', priority: 0, updatedAt: '2026-03-09T00:00:00Z' }),
    issue({ key: 'A-2', priority: 3, updatedAt: '2026-03-01T00:00:00Z' }),
    issue({ key: 'A-3', priority: 1, updatedAt: '2026-02-01T00:00:00Z' }),
    issue({ key: 'A-4', priority: 3, updatedAt: '2026-03-05T00:00:00Z' })
  ]
  assert.deepEqual(sortIssues(list).map((i) => i.key), ['A-3', 'A-4', 'A-2', 'A-1'])
})

test('groups by the team states, in Linear order, with recent done work collapsed', () => {
  const list = [
    issue({ key: 'A-1', state: { name: 'Backlog', type: 'backlog' } }),
    issue({ key: 'A-2', state: { name: 'In Review', type: 'started' } }),
    issue({ key: 'A-3', state: { name: 'In Progress', type: 'started' } }),
    issue({ key: 'A-4', state: { name: 'Todo', type: 'unstarted' } }),
    issue({ key: 'A-5', state: { name: 'Done', type: 'completed' }, updatedAt: new Date(NOW - 2 * DAY).toISOString() }),
    issue({ key: 'A-6', state: { name: 'Done', type: 'completed' }, updatedAt: new Date(NOW - 40 * DAY).toISOString() }),
    issue({ key: 'A-7', state: { name: 'Triage', type: 'triage' } }),
    issue({ key: 'A-8', state: { name: 'Canceled', type: 'canceled' }, updatedAt: new Date(NOW - DAY).toISOString() })
  ]
  const groups = groupIssues(list, { now: NOW, completedDays: 14 })
  assert.deepEqual(
    groups.map((g) => [g.name, g.issues.map((i) => i.key), g.collapsed]),
    [
      ['Triage', ['A-7'], false],
      ['In Progress', ['A-3'], false],
      ['In Review', ['A-2'], false],
      ['Todo', ['A-4'], false],
      ['Backlog', ['A-1'], false],
      ['Done', ['A-5'], true],
      ['Canceled', ['A-8'], true]
    ]
  )
})

test('known state positions order groups of one type', () => {
  const list = [issue({ key: 'A-1', state: { name: 'QA', type: 'started' } }), issue({ key: 'A-2', state: { name: 'Doing', type: 'started' } })]
  const groups = groupIssues(list, { now: NOW, positions: { QA: 3, Doing: 1 } })
  assert.deepEqual(groups.map((g) => g.name), ['Doing', 'QA'])
  assert.equal(groups[0].progress < groups[1].progress, true)
})

test('reads the issue key from a branch name', () => {
  assert.equal(keyFromBranch('pat/eng-123-fix-login'), 'ENG-123')
  assert.equal(keyFromBranch('feature/ENG-7'), 'ENG-7')
  assert.equal(keyFromBranch('eng-42'), 'ENG-42')
  assert.equal(keyFromBranch('main'), null)
  assert.equal(keyFromBranch('release-2026'), 'RELEASE-2026')
  // Known team keys win over anything else that looks like a key.
  assert.equal(keyFromBranch('release-2026/eng-9-x', ['ENG']), 'ENG-9')
  assert.equal(keyFromBranch('release-2026', ['ENG']), null)
  assert.equal(keyFromBranch(null), null)
})

test('due dates: overdue, soon, or nothing', () => {
  assert.equal(dueState('2026-03-09', NOW), 'overdue')
  assert.equal(dueState('2026-03-10', NOW), 'soon')
  assert.equal(dueState('2026-03-12', NOW), 'soon')
  assert.equal(dueState('2026-04-01', NOW), null)
  assert.equal(dueState(null, NOW), null)
})

test('the status bar counts work in progress and open urgent issues', () => {
  assert.equal(statusBarView([]), null)
  assert.equal(statusBarView([issue({ state: { type: 'backlog', name: 'Backlog' }, priority: 2 })]), null)
  const view = statusBarView([
    issue({ state: { type: 'started', name: 'In Progress' } }),
    issue({ state: { type: 'started', name: 'In Review' }, priority: 1 }),
    issue({ state: { type: 'unstarted', name: 'Todo' }, priority: 1 }),
    issue({ state: { type: 'completed', name: 'Done' }, priority: 1 })
  ])
  assert.deepEqual(view, { text: '2 in progress · 2 urgent', icon: 'activity', tone: 'warning', tooltip: 'Linear: 2 issues in progress, 2 urgent issues open' })
  assert.equal(statusBarView([issue({ state: { type: 'started', name: 'In Progress' } })]).text, '1 in progress')
  assert.equal(statusBarView([issue({ state: { type: 'started', name: 'In Progress' } })]).tone, 'neutral')
  assert.equal(statusBarView([issue({ state: { type: 'unstarted', name: 'Todo' }, priority: 1 })]).text, '1 urgent')
})

test('text search matches key, title, labels and project', () => {
  const a = issue({ key: 'ENG-5', title: 'Fix the login page', labels: [{ id: 'l', name: 'Bug', color: '#f00' }], project: { id: 'p', name: 'Auth revamp', color: '#0f0' } })
  assert.equal(matchesText(a, 'eng-5'), true)
  assert.equal(matchesText(a, 'LOGIN'), true)
  assert.equal(matchesText(a, 'bug'), true)
  assert.equal(matchesText(a, 'revamp'), true)
  assert.equal(matchesText(a, 'nothing'), false)
  assert.equal(matchesText(a, ''), true)
})

test('open means not completed, canceled or duplicate', () => {
  assert.equal(isOpen(issue({ state: { type: 'started' } })), true)
  assert.equal(isOpen(issue({ state: { type: 'duplicate' } })), false)
})
