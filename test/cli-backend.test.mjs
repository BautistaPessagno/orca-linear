import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCliBackend, createCliRunner, normalizeIssue } from '../backends/cli.mjs'
import { cliRow } from './fixtures.mjs'

const TEAMS = {
  teams: [
    { id: 'team-eng', name: 'Engineering', key: 'ENG', workspace: { id: 'ws-acme', name: 'acme' } },
    { id: 'team-ops', name: 'Ops', key: 'OPS', workspace: { id: 'ws-acme', name: 'acme' } },
    { id: 'team-lab', name: 'Lab', key: 'LAB', workspace: { id: 'ws-home', name: 'home-lab' } }
  ],
  meta: { partial: false, workspaceErrors: [] }
}

// A runner stand-in: records every argv and answers by the command words.
function fakeRun(answers = {}) {
  const calls = []
  const run = async (args, options = {}) => {
    calls.push({ args, stdin: options.stdin })
    const words = args.filter((a) => !a.startsWith('-')).slice(0, 3).join(' ')
    for (const [prefix, answer] of Object.entries(answers)) if (words.startsWith(prefix)) return typeof answer === 'function' ? answer(args) : structuredClone(answer)
    if (words.startsWith('linear team list')) return structuredClone(TEAMS)
    return { issues: [], meta: {} }
  }
  return { run, calls }
}

const argOf = (args, flag) => args[args.indexOf(flag) + 1]

test('normalizes a CLI issue row', () => {
  const issue = normalizeIssue(cliRow())
  assert.equal(issue.key, 'ENG-1')
  assert.deepEqual(issue.state, { id: 'state-ip', name: 'In Progress', type: 'started', color: '#f2c94c' })
  assert.deepEqual(issue.assignee, { id: 'user-me', name: 'Pat Example', avatarUrl: 'https://public.linear.app/avatars/pat.png' })
  assert.deepEqual(issue.cycle, { id: 'cycle-1', number: null, name: null, startsAt: null, endsAt: null })
  assert.equal(issue.workspace.id, 'ws-acme')
  assert.equal('description' in issue, false)
})

test('lists workspaces and teams from one team list call', async () => {
  const { run, calls } = fakeRun()
  const backend = createCliBackend({ run })
  assert.deepEqual(await backend.workspaces(), [{ id: 'ws-acme', name: 'acme' }, { id: 'ws-home', name: 'home-lab' }])
  assert.deepEqual((await backend.teams('ws-home')).map((t) => t.key), ['LAB'])
  assert.equal(calls.length, 1)
})

test('my issues across every workspace', async () => {
  const { run, calls } = fakeRun({ 'linear list-issues': { issues: [cliRow()], truncated: false, meta: { partial: false, workspaceErrors: [] } } })
  const result = await createCliBackend({ run }).listIssues('all', { view: 'mine' })
  assert.deepEqual(calls[0].args, ['linear', 'list-issues', '--assignee', 'me', '--workspace', 'all'])
  assert.equal(result.issues[0].key, 'ENG-1')
  assert.equal(result.partial, false)
})

test('a team filter carries its own workspace', async () => {
  const { run, calls } = fakeRun()
  await createCliBackend({ run }).listIssues('all', { view: 'backlog', team: 'team-lab', project: 'proj-9' })
  const args = calls.find((c) => c.args[1] === 'list-issues').args
  assert.equal(argOf(args, '--state'), 'backlog')
  assert.equal(argOf(args, '--team'), 'LAB')
  assert.equal(argOf(args, '--workspace'), 'ws-home')
  assert.equal(argOf(args, '--project'), 'proj-9')
})

test('created by me filters the project after the call', async () => {
  const rows = [cliRow({ identifier: 'ENG-1' }), cliRow({ identifier: 'ENG-2', project: null })]
  const { run, calls } = fakeRun({ 'linear list': { issues: rows, meta: {} } })
  const result = await createCliBackend({ run }).listIssues('ws-acme', { view: 'created', project: 'proj-1' })
  assert.deepEqual(calls[0].args, ['linear', 'list', '--filter', 'created', '--limit', '250', '--workspace', 'ws-acme'])
  assert.deepEqual(result.issues.map((i) => i.key), ['ENG-1'])
})

test('the current cycle needs the API backend', async () => {
  const { run } = fakeRun()
  await assert.rejects(createCliBackend({ run }).listIssues('all', { view: 'cycle' }), (e) => e.kind === 'unsupported')
})

test('search sends the text as one argument', async () => {
  const { run, calls } = fakeRun()
  await createCliBackend({ run }).listIssues('all', { view: 'search', text: '--assignee null' })
  assert.equal(argOf(calls[0].args, '--query'), '--assignee null')
  await assert.rejects(createCliBackend({ run }).listIssues('all', { view: 'search', text: '  ' }), (e) => e.kind === 'invalid')
})

test('refuses ids that could be read as flags', async () => {
  const { run, calls } = fakeRun()
  const backend = createCliBackend({ run })
  await assert.rejects(backend.issue('ws-acme', '--help'), (e) => e.kind === 'invalid')
  await assert.rejects(backend.listIssues('--x', { view: 'mine' }), (e) => e.kind === 'invalid')
  await assert.rejects(backend.update('ws-acme', 'ENG-1', { assignee: '--me' }), (e) => e.kind === 'invalid')
  assert.equal(calls.length, 0)
})

test('reads an issue with every section', async () => {
  const detail = {
    issue: cliRow(),
    meta: { resolved: { workspaceId: 'ws-acme', workspaceName: 'acme' }, sections: { comments: { hasMore: true }, children: { capReached: false } } },
    comments: [{ id: 'c1', body: 'Made-up comment', bodyTruncated: false, createdAt: '2026-03-01T00:00:00Z', parentId: null, user: { id: 'u2', displayName: 'Sam', avatarUrl: null } }],
    children: [cliRow({ identifier: 'ENG-2' })],
    relations: [{ id: 'r1', type: 'blocks', direction: 'inbound', relationship: 'blockedBy', relatedIssue: { id: 'i9', identifier: 'ENG-9', title: 'Other', url: 'https://linear.app/acme/issue/ENG-9' } }],
    attachments: [{ id: 'a1', title: 'PR #4', url: 'https://github.com/acme/app/pull/4', source: { type: 'github' }, subtitle: null, createdAt: '2026-03-01T00:00:00Z' }]
  }
  const { run, calls } = fakeRun({ 'linear issue': detail })
  const result = await createCliBackend({ run }).issue('ws-acme', 'eng-1')
  assert.deepEqual(calls[0].args, ['linear', 'issue', 'ENG-1', '--comments', '--children', '--relations', '--attachments', '--depth', '1', '--workspace', 'ws-acme'])
  assert.equal(result.issue.description, 'Made-up description')
  assert.equal(result.comments[0].user.name, 'Sam')
  assert.deepEqual(result.relations[0], { id: 'r1', kind: 'blockedBy', issue: { id: 'i9', key: 'ENG-9', title: 'Other', url: 'https://linear.app/acme/issue/ENG-9' } })
  assert.equal(result.attachments[0].source, 'github')
  assert.equal(result.children[0].key, 'ENG-2')
  assert.equal(result.more.comments, true)
})

test('reads a team’s states in order, members and labels', async () => {
  const { run } = fakeRun({
    'linear team states': { states: [{ id: 's2', name: 'Done', type: 'completed', color: '#0f0', position: 5 }, { id: 's1', name: 'Todo', type: 'unstarted', color: '#ccc', position: 1 }] },
    'linear team members': { members: [{ id: 'u1', displayName: 'Pat', avatarUrl: null }] },
    'linear team labels': { labels: [{ id: 'l1', name: 'Bug', color: '#f00' }] }
  })
  const meta = await createCliBackend({ run }).teamMeta('ws-acme', 'ENG')
  assert.deepEqual(meta.states.map((s) => s.name), ['Todo', 'Done'])
  assert.deepEqual(meta.members, [{ id: 'u1', name: 'Pat', avatarUrl: null }])
  assert.equal(meta.labels[0].name, 'Bug')
})

test('every write maps to its CLI command (fake runner only)', async () => {
  const { run, calls } = fakeRun()
  const backend = createCliBackend({ run })
  await backend.update('ws-acme', 'ENG-1', { state: { id: 's1', name: 'In Review' } })
  await backend.update('ws-acme', 'ENG-1', { priority: 1 })
  await backend.update('ws-acme', 'ENG-1', { priority: 0 })
  await backend.update('ws-acme', 'ENG-1', { assignee: 'me' })
  await backend.update('ws-acme', 'ENG-1', { assignee: null })
  await backend.update('ws-acme', 'ENG-1', { assignee: 'user-7' })
  await backend.comment('ws-acme', 'ENG-1', 'Line one\nLine two')
  assert.deepEqual(
    calls.map((c) => c.args.join(' ')),
    [
      'linear status set ENG-1 --to In Review --workspace ws-acme',
      'linear priority set ENG-1 --to urgent --workspace ws-acme',
      'linear priority set ENG-1 --to none --workspace ws-acme',
      'linear assignee set ENG-1 --me --workspace ws-acme',
      'linear assignee clear ENG-1 --workspace ws-acme',
      'linear assignee set ENG-1 --to-id user-7 --workspace ws-acme',
      'linear comment add ENG-1 --body-file - --workspace ws-acme'
    ]
  )
  assert.equal(calls.at(-1).stdin, 'Line one\nLine two')
})

test('the runner adds --json, parses the reply and maps CLI errors', async () => {
  const seen = []
  const execFileImpl = (bin, args, options, callback) => {
    seen.push({ bin, args, options })
    const out = args[0] === 'ok' ? { ok: true, result: { x: 1 } } : { ok: false, error: { code: 'linear_network_error', message: 'Entity not found: Issue' } }
    setImmediate(() => callback(args[0] === 'ok' ? null : Object.assign(new Error('exit 1'), { code: 1 }), JSON.stringify(out), ''))
    return { stdin: { end() {} } }
  }
  const run = createCliRunner({ locate: async () => '/bin/orca', execFileImpl })
  assert.deepEqual(await run(['ok']), { x: 1 })
  assert.deepEqual(seen[0].args, ['ok', '--json'])
  await assert.rejects(run(['bad']), (e) => e.kind === 'not-found')
})

test('the runner finds orca again when it went missing', async () => {
  let located = 0
  const execFileImpl = (bin, args, options, callback) => {
    setImmediate(() => (bin === '/old/orca' ? callback(Object.assign(new Error('nope'), { code: 'ENOENT' }), '', '') : callback(null, '{"ok":true,"result":{"v":2}}', '')))
    return {}
  }
  const run = createCliRunner({ locate: async () => (located++ === 0 ? '/old/orca' : '/new/orca'), execFileImpl })
  assert.deepEqual(await run(['x']), { v: 2 })
  assert.equal(located, 2)
})

test('the runner pipes a comment body on stdin', async () => {
  let written
  const execFileImpl = (bin, args, options, callback) => {
    setImmediate(() => callback(null, '{"ok":true,"result":{}}', ''))
    return { stdin: { end: (text) => (written = text) } }
  }
  await createCliRunner({ locate: async () => '/bin/orca', execFileImpl })(['comment'], { stdin: 'hello' })
  assert.equal(written, 'hello')
})
