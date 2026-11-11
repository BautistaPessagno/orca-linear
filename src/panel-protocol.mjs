// Worker side of the panel: the handlers it calls with `orca.plugin.request(name, input)`.
// worker.mjs registers each with `orca.panels.handle`. A failure comes back as `{ error: { kind,
// message } }` rather than a rejection, so the panel can show the sentence in place.
//
//   app.state                                   → { workspaces, errors, mode, keys, focus }
//   focus.get                                   → { branch, key } | null
//   teams.list       { workspace }              → Team[]
//   projects.list    { workspace }              → Project[]
//   issues.list      { view, workspace, team?, project?, force? } → { issues, at, stale, partial, errors, key }
//   issues.search    { workspace, team?, text } → { issues }
//   issue.get        { workspace, key }         → IssueDetail
//   team.meta        { workspace, team }        → { states, members, labels } (team = key)
//   issue.update     { workspace, key, team, change } → IssueDetail after the change
//                    change = { state: name } | { priority: 0–4 } | { assignee: 'me' | null | userId }
//   issue.comment    { workspace, key, body }   → IssueDetail after the comment
//   avatar           { url }                    → { url, dataUrl }
//   keys.add         { key }                    → { id, name }
//   keys.remove      { workspace }              → { ok }
//   work.find        { key, branchName }        → { workspaces, canCreate, repository }
//   work.open        { workspaceId }            → { opened }
//   work.start       { key, branchName }        → { opened, created, workspace }
//
// Writes run only from a panel press; each input is checked against the team's own states and
// members before the backend sees it.
import { bad, errorReply } from './errors.mjs'
import { keyFromBranch } from './model.mjs'
import { checkKey } from '../backends/cli.mjs'

export const VIEWS = Object.freeze(['mine', 'cycle', 'backlog', 'created', 'triage'])
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const TEAM_KEY = /^[A-Za-z0-9]{1,10}$/
const MAX_COMMENT = 10_000
const META_TTL_MS = 10 * 60_000
const DETAIL_CACHE = 40

const workspaceOf = (input, { all = true } = {}) => {
  const ws = input?.workspace ?? 'all'
  if (ws === 'all') {
    if (all) return ws
    throw bad('Pick a Linear workspace.')
  }
  if (typeof ws !== 'string' || !ID.test(ws)) throw bad('Pick a Linear workspace.')
  return ws
}
const optionalId = (value, what) => {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !ID.test(value)) throw bad(`Expected a ${what} id.`)
  return value
}
const teamKeyOf = (value) => {
  if (typeof value !== 'string' || !TEAM_KEY.test(value)) throw bad('Expected a team key.')
  return value
}

export function createPanelHandlers({ selector, store, keys, avatars, startWork, host, now = Date.now, dev = null }) {
  const metaCache = new Map()
  const details = new Map()

  const teamMeta = async (ws, team, { force = false } = {}) => {
    const id = `${ws}|${team}`
    const hit = metaCache.get(id)
    if (!force && hit && now() - hit.at < META_TTL_MS) return hit.value
    const value = await selector.teamMeta(ws, team)
    metaCache.set(id, { at: now(), value })
    return value
  }

  const detail = async (ws, key) => {
    const value = avatars.remember(await selector.issue(ws, key))
    details.set(`${ws}|${key}`, value)
    if (details.size > DETAIL_CACHE) details.delete(details.keys().next().value)
    return value
  }

  const focus = async () => {
    const context = await host.call('workspace.readContext').catch(() => null)
    if (!context?.branch) return null
    const branch = context.branch.replace(/^refs\/heads\//, '')
    let teamKeys
    try {
      teamKeys = (await selector.teams('all')).map((t) => t.key)
    } catch {
      teamKeys = undefined
    }
    return { branch, name: context.displayName ?? null, key: keyFromBranch(branch, teamKeys) }
  }

  // Each handler's failure becomes `{ error }`.
  const safe = (fn) => async (input, context) => {
    try {
      return await fn(input ?? {}, context)
    } catch (error) {
      return errorReply(error)
    }
  }

  const handlers = {
    'app.state': async () => {
      const [{ workspaces, errors }, mode, keyList, focused] = await Promise.all([
        selector.workspaces().catch((error) => ({ workspaces: [], errors: [errorReply(error).error] })),
        selector.mode(),
        keys.list(),
        focus()
      ])
      const state = { workspaces, errors, mode, keys: keyList.map((w) => ({ id: w.id, name: w.name })), focus: focused }
      // Screenshots only: where the panel should open (fixture mode).
      if (dev) state.dev = dev
      return state
    },

    'focus.get': focus,

    'teams.list': async (input) => selector.teams(workspaceOf(input)),

    'projects.list': async (input) => selector.projects(workspaceOf(input)),

    'issues.list': async (input) => {
      if (!VIEWS.includes(input.view)) throw bad(`Unknown view: ${input.view}`)
      const params = { view: input.view, workspace: workspaceOf(input), team: optionalId(input.team, 'team'), project: optionalId(input.project, 'project') }
      return avatars.remember(await store.list(params, { force: Boolean(input.force) }))
    },

    'issues.search': async (input) => {
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      if (!text || text.length > 200) throw bad('Type something to search for.')
      const result = await selector.listIssues(workspaceOf(input), { view: 'search', text, team: optionalId(input.team, 'team') })
      return avatars.remember({ issues: result.issues, errors: result.errors ?? [] })
    },

    'issue.get': async (input) => {
      const ws = workspaceOf(input, { all: false })
      const key = checkKey(input.key)
      if (input.cached) {
        const hit = details.get(`${ws}|${key}`)
        if (hit) return { ...hit, cached: true }
      }
      return detail(ws, key)
    },

    'team.meta': async (input) => avatars.remember(await teamMeta(workspaceOf(input, { all: false }), teamKeyOf(input.team))),

    'issue.update': async (input) => {
      const ws = workspaceOf(input, { all: false })
      const key = checkKey(input.key)
      const change = input.change ?? {}
      const fields = Object.keys(change)
      if (fields.length !== 1) throw bad('Change one thing at a time.')
      let checked
      if ('state' in change) {
        const meta = await teamMeta(ws, teamKeyOf(input.team))
        const state = meta.states.find((s) => s.name === change.state || s.id === change.state)
        if (!state) throw bad('That status is not one of the team’s.')
        checked = { state: { id: state.id, name: state.name } }
      } else if ('priority' in change) {
        if (!Number.isInteger(change.priority) || change.priority < 0 || change.priority > 4) throw bad('Priority is 0 (none) to 4 (low).')
        checked = { priority: change.priority }
      } else if ('assignee' in change) {
        const who = change.assignee
        if (who !== null && who !== 'me') {
          const meta = await teamMeta(ws, teamKeyOf(input.team))
          if (!meta.members.some((m) => m.id === who)) throw bad('That person is not on the team.')
        }
        checked = { assignee: who }
      } else throw bad('Nothing to change.')
      await selector.update(ws, key, checked)
      store.invalidate()
      return detail(ws, key)
    },

    'issue.comment': async (input) => {
      const ws = workspaceOf(input, { all: false })
      const key = checkKey(input.key)
      const body = typeof input.body === 'string' ? input.body.replace(/\r\n/g, '\n').trim() : ''
      if (!body) throw bad('Write a comment first.')
      if (body.length > MAX_COMMENT) throw bad(`A comment can be at most ${MAX_COMMENT} characters.`)
      await selector.comment(ws, key, body)
      return detail(ws, key)
    },

    avatar: async (input) => ({ url: input.url ?? null, dataUrl: await avatars.get(input.url) }),

    'keys.add': async (input) => {
      const added = await keys.add(input.key)
      store.invalidate()
      return added
    },

    'keys.remove': async (input) => {
      await keys.remove(workspaceOf(input, { all: false }))
      store.invalidate()
      return { ok: true }
    },

    'work.find': async (input) => startWork.find(input),
    'work.open': async (input) => startWork.open(input),
    'work.start': async (input) => startWork.start(input)
  }

  return Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, safe(fn)]))
}
