// The zero-setup backend: Orca's own Linear connection, through `orca linear … --json`.
// Every call is one CLI process (~0.5–2 s), so reads batch with `--workspace all` where they can
// and the worker caches what comes back. What the CLI returns and lacks is in
// docs/research/linear-backends.md; the big gap is cycles (no current cycle), so `cycle` refuses.
import { execFile } from 'node:child_process'
import { LinearError, MESSAGES, bad } from '../src/errors.mjs'
import { PRIORITY_WORDS } from '../src/model.mjs'

export const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const TIMEOUT_MS = 30_000
const MAX_OUTPUT = 32 * 1024 * 1024
const LIST_LIMIT = 250
const TEAMS_TTL_MS = 10 * 60_000

// Runs one `orca` command and returns its `result`. Arguments go straight to execFile (no
// shell); `stdin` carries a comment body and `cwd` picks the folder (start work). The executable
// is found once and found again if it disappears (Orca moved or updated).
export function createCliRunner({ locate, execFileImpl = execFile, timeoutMs = TIMEOUT_MS }) {
  let path = null
  const resolve = async () => (path ??= await locate())

  const once = (bin, args, stdin, cwd) =>
    new Promise((done, fail) => {
      const child = execFileImpl(bin, [...args, '--json'], { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true, ...(cwd ? { cwd } : {}) }, (error, stdout, stderr) => {
        if (error?.code === 'ENOENT') return fail(Object.assign(new Error('missing'), { missing: true }))
        let reply
        try {
          reply = JSON.parse(String(stdout))
        } catch {
          if (error?.killed) return fail(new LinearError('error', 'The Orca CLI did not answer in time.'))
          return fail(new LinearError('error', `The Orca CLI failed: ${String(stderr || error?.message || 'no output').trim().slice(0, 300)}`))
        }
        if (reply?.ok) return done(reply.result)
        fail(cliError(reply?.error))
      })
      if (stdin !== undefined) {
        child?.stdin?.end(stdin)
      }
    })

  const run = async function run(args, { stdin, cwd } = {}) {
    try {
      return await once(await resolve(), args, stdin, cwd)
    } catch (error) {
      if (!error.missing) throw error
      path = null
      return once(await resolve(), args, stdin, cwd)
    }
  }
  // Forget the executable, e.g. after the Orca CLI path setting changed.
  run.reset = () => (path = null)
  return run
}

export function cliError(error) {
  const message = String(error?.message ?? 'The Orca CLI reported an error.')
  const code = String(error?.code ?? '')
  if (/not found|could not find/i.test(message)) return new LinearError('not-found', MESSAGES.notFound)
  if (/not connected|no linear|connect linear|unauthori[sz]ed|not authenticated/i.test(`${code} ${message}`)) return new LinearError('not-connected', MESSAGES.notConnected)
  if (/rate.?limit/i.test(`${code} ${message}`)) return new LinearError('rate-limited', MESSAGES.rateLimited, { retryAfterMs: 60_000 })
  return new LinearError('error', message.slice(0, 300))
}

const person = (u) => (u ? { id: u.id, name: u.displayName ?? u.name ?? '', avatarUrl: u.avatarUrl ?? null } : null)

export function normalizeIssue(row, workspace) {
  return {
    id: row.id,
    key: row.identifier,
    title: row.title ?? '',
    url: row.url ?? null,
    workspace: row.workspace ? { id: row.workspace.id, name: row.workspace.name } : workspace ?? null,
    team: row.team ? { id: row.team.id, key: row.team.key, name: row.team.name, color: row.team.color ?? null } : null,
    state: row.state ? { id: row.state.id ?? null, name: row.state.name, type: row.state.type, color: row.state.color ?? null } : null,
    priority: Number.isInteger(row.priority) ? row.priority : 0,
    project: row.project ? { id: row.project.id, name: row.project.name, color: row.project.color ?? null } : null,
    cycle: row.cycle ? { id: row.cycle.id, number: row.cycle.number ?? null, name: row.cycle.name ?? null, startsAt: null, endsAt: null } : null,
    assignee: person(row.assignee),
    labels: (row.labels ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color ?? null })),
    estimate: row.estimate ?? null,
    dueDate: row.dueDate ?? null,
    branchName: row.branchName ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null
  }
}

function normalizeDetail(result) {
  const workspace = result.meta?.resolved ? { id: result.meta.resolved.workspaceId, name: result.meta.resolved.workspaceName } : null
  const sections = result.meta?.sections ?? {}
  return {
    issue: { ...normalizeIssue(result.issue, workspace), description: result.issue.description ?? '' },
    comments: (result.comments ?? []).map((c) => ({ id: c.id, body: c.body ?? '', truncated: Boolean(c.bodyTruncated), createdAt: c.createdAt, parentId: c.parentId ?? null, user: person(c.user) })),
    children: (result.children ?? []).map((c) => normalizeIssue(c, workspace)),
    relations: (result.relations ?? []).map((r) => ({ id: r.id, kind: r.relationship ?? r.type, issue: { id: r.relatedIssue?.id, key: r.relatedIssue?.identifier, title: r.relatedIssue?.title ?? '', url: r.relatedIssue?.url ?? null } })),
    attachments: (result.attachments ?? []).map((a) => ({ id: a.id, title: a.title ?? a.url, subtitle: a.subtitle ?? null, url: a.url, source: a.source?.type ?? null, createdAt: a.createdAt ?? null })),
    more: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, Boolean(v?.hasMore || v?.capReached)]))
  }
}

export const checkKey = (key) => {
  if (typeof key !== 'string' || !ISSUE_KEY.test(key)) throw bad('Expected an issue key such as ENG-123.')
  return key.toUpperCase()
}
const checkId = (id, what) => {
  if (typeof id !== 'string' || !ID.test(id)) throw bad(`Expected a ${what} id.`)
  return id
}
const wsArgs = (ws) => ['--workspace', ws === 'all' || !ws ? 'all' : checkId(ws, 'workspace')]

export function createCliBackend({ run, now = Date.now }) {
  let teamsCache = null

  const allTeams = async () => {
    if (teamsCache && now() - teamsCache.at < TEAMS_TTL_MS) return teamsCache.teams
    const result = await run(['linear', 'team', 'list', '--workspace', 'all'])
    const teams = (result.teams ?? []).map((t) => ({ id: t.id, key: t.key, name: t.name, color: t.color ?? null, workspaceId: t.workspace?.id, workspaceName: t.workspace?.name }))
    teamsCache = { at: now(), teams }
    return teams
  }

  const issuesOf = (result) => ({
    issues: (result.issues ?? []).map((row) => normalizeIssue(row)),
    partial: Boolean(result.meta?.partial || result.truncated),
    errors: (result.meta?.workspaceErrors ?? []).map((e) => String(e?.message ?? e))
  })

  // A team view names a team; it carries its own workspace, since `--team` alone looks in the
  // default workspace only.
  const teamArgs = async (ws, teamId) => {
    if (!teamId) return wsArgs(ws)
    const team = (await allTeams()).find((t) => t.id === teamId)
    if (!team) throw bad('That team is not in a connected Linear workspace.')
    return ['--team', team.key, '--workspace', team.workspaceId]
  }

  const filters = async (ws, query) => {
    const args = await teamArgs(ws, query.team)
    if (query.project) args.push('--project', checkId(query.project, 'project'))
    return args
  }

  const VIEWS = {
    mine: async (ws, q) => run(['linear', 'list-issues', '--assignee', 'me', ...(await filters(ws, q))]),
    created: async (ws, q) => {
      // `list --filter created` takes a team but no project; the project filter is applied after.
      const args = ['linear', 'list', '--filter', 'created', '--limit', String(LIST_LIMIT)]
      if (q.team) {
        const [, key, , workspace] = await teamArgs(ws, q.team)
        args.push('--team', key, '--workspace', workspace)
      } else args.push(...wsArgs(ws))
      const result = await run(args)
      if (q.project) result.issues = (result.issues ?? []).filter((row) => row.project?.id === q.project)
      return result
    },
    backlog: async (ws, q) => run(['linear', 'list-issues', '--state', 'backlog', '--limit', String(LIST_LIMIT), ...(await filters(ws, q))]),
    triage: async (ws, q) => run(['linear', 'list-issues', '--state', 'triage', '--limit', String(LIST_LIMIT), ...(await filters(ws, q))]),
    search: async (ws, q) => {
      const text = String(q.text ?? '').trim()
      if (!text || text.length > 200) throw bad('Type something to search for.')
      return run(['linear', 'list-issues', '--query', text, '--limit', '50', ...(await filters(ws, q))])
    },
    cycle: async () => {
      throw new LinearError('unsupported', MESSAGES.cycleNeedsKey)
    }
  }

  return {
    id: 'cli',
    capabilities: Object.freeze({ cycles: false }),

    async workspaces() {
      const seen = new Map()
      for (const t of await allTeams()) if (t.workspaceId && !seen.has(t.workspaceId)) seen.set(t.workspaceId, { id: t.workspaceId, name: t.workspaceName ?? t.workspaceId })
      return [...seen.values()]
    },

    async teams(ws) {
      const teams = await allTeams()
      return ws && ws !== 'all' ? teams.filter((t) => t.workspaceId === ws) : teams
    },

    async listIssues(ws, query = {}) {
      const view = VIEWS[query.view]
      if (!view) throw bad(`Unknown view: ${query.view}`)
      return issuesOf(await view(ws, query))
    },

    async issue(ws, key) {
      const args = ['linear', 'issue', checkKey(key), '--comments', '--children', '--relations', '--attachments', '--depth', '1']
      if (ws && ws !== 'all') args.push('--workspace', checkId(ws, 'workspace'))
      return normalizeDetail(await run(args))
    },

    async teamMeta(ws, teamKey) {
      if (typeof teamKey !== 'string' || !/^[A-Za-z0-9]{1,10}$/.test(teamKey)) throw bad('Expected a team key.')
      const base = ['--team', teamKey, '--workspace', checkId(ws, 'workspace')]
      const [states, members, labels] = await Promise.all([
        run(['linear', 'team', 'states', ...base]),
        run(['linear', 'team', 'members', ...base]),
        run(['linear', 'team', 'labels', ...base])
      ])
      return {
        states: (states.states ?? []).map((s) => ({ id: s.id, name: s.name, type: s.type, color: s.color ?? null, position: s.position ?? 0 })).sort((a, b) => a.position - b.position),
        members: (members.members ?? []).map(person),
        labels: (labels.labels ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color ?? null }))
      }
    },

    async projects(ws) {
      const result = await run(['linear', 'project', 'list', '--limit', String(LIST_LIMIT), ...wsArgs(ws)])
      return (result.projects ?? []).map((p) => ({ id: p.id, name: p.name, workspaceId: p.workspaceId, teamIds: (p.teams ?? []).map((t) => t.id) }))
    },

    // One change at a time: { state: name } | { priority: 0–4 } | { assignee: 'me' | null | userId }.
    async update(ws, key, change) {
      const id = checkKey(key)
      const where = ['--workspace', checkId(ws, 'workspace')]
      if ('state' in change) return void (await run(['linear', 'status', 'set', id, '--to', String(change.state.name), ...where]))
      if ('priority' in change) return void (await run(['linear', 'priority', 'set', id, '--to', PRIORITY_WORDS[change.priority], ...where]))
      if ('assignee' in change) {
        if (change.assignee === null) return void (await run(['linear', 'assignee', 'clear', id, ...where]))
        if (change.assignee === 'me') return void (await run(['linear', 'assignee', 'set', id, '--me', ...where]))
        return void (await run(['linear', 'assignee', 'set', id, '--to-id', checkId(change.assignee, 'user'), ...where]))
      }
      throw bad('Nothing to change.')
    },

    async comment(ws, key, body) {
      await run(['linear', 'comment', 'add', checkKey(key), '--body-file', '-', '--workspace', checkId(ws, 'workspace')], { stdin: body })
    }
  }
}
