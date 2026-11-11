// The optional backend: Linear's GraphQL API with a personal API key per Linear workspace.
// It adds the current cycle, which the CLI cannot tell, and answers a view in one round trip.
//
//   POST https://api.linear.app/graphql, `Authorization: <key>` (no Bearer for personal keys).
//   Errors come in `errors` even on HTTP 200; 429 with RATELIMITED and Retry-After when limited.
//   (docs/research/linear-backends.md)
import { LinearError, MESSAGES, bad } from '../src/errors.mjs'
import { DONE_TYPES } from '../src/model.mjs'
import { checkKey } from './cli.mjs'

export const ENDPOINT = 'https://api.linear.app/graphql'
const TIMEOUT_MS = 20_000
const PAGE = 50
const MAX_PAGES = 5
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const DAY = 86_400_000

const ISSUE_FIELDS = `
  id identifier title url priority estimate dueDate branchName createdAt updatedAt
  state { id name type color }
  team { id key name color }
  project { id name color }
  cycle { id number name startsAt endsAt }
  assignee { id displayName avatarUrl }
  labels(first: 10) { nodes { id name color } }`

export function createGraphqlClient({ fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  return async function gql(key, query, variables = {}) {
    let response
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      throw new LinearError('error', `Could not reach Linear: ${error.message}`)
    }
    let body = null
    try {
      body = JSON.parse(await response.text())
    } catch {
      // A proxy page or an empty body; the status says enough.
    }
    const codes = (body?.errors ?? []).map((e) => e?.extensions?.code)
    if (response.status === 429 || codes.includes('RATELIMITED')) {
      const seconds = Number(response.headers?.get?.('retry-after'))
      throw new LinearError('rate-limited', MESSAGES.rateLimited, { retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000 })
    }
    if (response.status === 401 || response.status === 403 || codes.includes('AUTHENTICATION_ERROR')) throw new LinearError('unauthenticated', MESSAGES.unauthenticated)
    if (body?.errors?.length) {
      const message = String(body.errors[0]?.message ?? 'Linear refused the request.')
      if (/not found|could not find/i.test(message)) throw new LinearError('not-found', MESSAGES.notFound)
      throw new LinearError('error', message.slice(0, 300))
    }
    if (!response.ok || !body?.data) throw new LinearError('error', `Linear answered HTTP ${response.status}.`)
    return body.data
  }
}

const person = (u) => (u ? { id: u.id, name: u.displayName ?? u.name ?? '', avatarUrl: u.avatarUrl ?? null } : null)

export function normalizeApiIssue(node, workspace) {
  return {
    id: node.id,
    key: node.identifier,
    title: node.title ?? '',
    url: node.url ?? null,
    workspace,
    team: node.team ? { id: node.team.id, key: node.team.key, name: node.team.name, color: node.team.color ?? null } : null,
    state: node.state ? { id: node.state.id, name: node.state.name, type: node.state.type, color: node.state.color ?? null } : null,
    priority: Number.isInteger(node.priority) ? node.priority : 0,
    project: node.project ? { id: node.project.id, name: node.project.name, color: node.project.color ?? null } : null,
    cycle: node.cycle ? { id: node.cycle.id, number: node.cycle.number ?? null, name: node.cycle.name ?? null, startsAt: node.cycle.startsAt ?? null, endsAt: node.cycle.endsAt ?? null } : null,
    assignee: person(node.assignee),
    labels: (node.labels?.nodes ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color ?? null })),
    estimate: node.estimate ?? null,
    dueDate: node.dueDate ?? null,
    branchName: node.branchName ?? null,
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null
  }
}

// Linear's relation types seen from either side.
const RELATION = { blocks: ['blocks', 'blockedBy'], related: ['relatedTo', 'relatedTo'], duplicate: ['duplicateOf', 'duplicatedBy'], similar: ['similarTo', 'similarTo'] }
const relationKind = (type, inbound) => (RELATION[type] ?? [type, type])[inbound ? 1 : 0]

const checkId = (id, what) => {
  if (typeof id !== 'string' || !ID.test(id)) throw bad(`Expected a ${what} id.`)
  return id
}

// The filter for a view; team and project narrow every view.
export function scopeFilter(query) {
  const filter = {}
  if (query.team) filter.team = { id: { eq: checkId(query.team, 'team') } }
  if (query.project) filter.project = { id: { eq: checkId(query.project, 'project') } }
  return filter
}

export function viewFilter(query, { now = Date.now(), completedDays = 14 } = {}) {
  const filter = scopeFilter(query)
  const recent = new Date(now - completedDays * DAY).toISOString()
  switch (query.view) {
    case 'mine':
      filter.assignee = { isMe: { eq: true } }
      filter.or = [{ state: { type: { nin: DONE_TYPES } } }, { updatedAt: { gt: recent } }]
      break
    case 'created':
      filter.creator = { isMe: { eq: true } }
      filter.or = [{ state: { type: { nin: DONE_TYPES } } }, { updatedAt: { gt: recent } }]
      break
    case 'backlog':
      filter.state = { type: { eq: 'backlog' } }
      break
    case 'triage':
      filter.state = { type: { eq: 'triage' } }
      break
    case 'cycle':
      filter.cycle = { isActive: { eq: true } }
      break
    default:
      throw bad(`Unknown view: ${query.view}`)
  }
  return filter
}

// `keys` holds the API keys: `list()` → [{ id, name, urlKey }], `get(workspaceId)` → key | null.
export function createApiBackend({ keys, gql, now = Date.now, completedDays = () => 14 }) {
  const viewerIds = new Map()
  const teamCache = new Map()

  const keyFor = async (ws) => {
    const key = await keys.get(checkId(ws, 'workspace'))
    if (!key) throw new LinearError('not-connected', MESSAGES.notConnected)
    return key
  }
  const workspaceOf = async (ws) => (await keys.list()).find((w) => w.id === ws) ?? { id: ws, name: ws }
  const call = async (ws, query, variables) => gql(await keyFor(ws), query, variables)

  const pages = async (ws, query, variables, pick) => {
    const nodes = []
    let after = null
    let partial = false
    for (let page = 0; page < MAX_PAGES; page++) {
      const connection = pick(await call(ws, query, { ...variables, after }))
      nodes.push(...(connection?.nodes ?? []))
      if (!connection?.pageInfo?.hasNextPage) return { nodes, partial }
      after = connection.pageInfo.endCursor
      partial = page === MAX_PAGES - 1
    }
    return { nodes, partial }
  }

  return {
    id: 'api',
    capabilities: Object.freeze({ cycles: true }),

    workspaces: async () => (await keys.list()).map((w) => ({ id: w.id, name: w.name })),

    async teams(ws) {
      const cached = teamCache.get(ws)
      if (cached && now() - cached.at < 10 * 60_000) return cached.teams
      const data = await call(ws, `query { teams(first: 100) { nodes { id key name color triageEnabled activeCycle { id number name startsAt endsAt } } } }`)
      const name = (await workspaceOf(ws)).name
      const teams = (data.teams?.nodes ?? []).map((t) => ({ id: t.id, key: t.key, name: t.name, color: t.color ?? null, workspaceId: ws, workspaceName: name, triage: Boolean(t.triageEnabled), activeCycle: t.activeCycle ?? null }))
      teamCache.set(ws, { at: now(), teams })
      return teams
    },

    async listIssues(ws, query = {}) {
      const workspace = await workspaceOf(ws)
      if (query.view === 'search') {
        const term = String(query.text ?? '').trim()
        if (!term || term.length > 200) throw bad('Type something to search for.')
        const data = await call(ws, `query($term: String!, $filter: IssueFilter) { searchIssues(term: $term, filter: $filter, first: ${PAGE}) { nodes { ${ISSUE_FIELDS} } } }`, {
          term,
          filter: Object.keys(scopeFilter(query)).length ? scopeFilter(query) : null
        })
        return { issues: (data.searchIssues?.nodes ?? []).map((n) => normalizeApiIssue(n, workspace)), partial: false, errors: [] }
      }
      const filter = viewFilter(query, { now: now(), completedDays: completedDays() })
      const { nodes, partial } = await pages(
        ws,
        `query($filter: IssueFilter, $after: String) { issues(filter: $filter, first: ${PAGE}, after: $after, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
        { filter },
        (data) => data.issues
      )
      return { issues: nodes.map((n) => normalizeApiIssue(n, workspace)), partial, errors: [] }
    },

    async issue(ws, key) {
      const id = checkKey(key)
      const data = await call(
        ws,
        `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} description
          children(first: 50) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage } }
          relations(first: 50) { nodes { id type relatedIssue { id identifier title url } } }
          inverseRelations(first: 50) { nodes { id type issue { id identifier title url } } }
          comments(first: 100) { nodes { id body createdAt parent { id } user { id displayName avatarUrl } } pageInfo { hasNextPage } }
          attachments(first: 50) { nodes { id title subtitle url sourceType createdAt } }
        } }`,
        { id }
      )
      const node = data.issue
      if (!node) throw new LinearError('not-found', MESSAGES.notFound)
      const workspace = await workspaceOf(ws)
      const linked = (i) => ({ id: i?.id, key: i?.identifier, title: i?.title ?? '', url: i?.url ?? null })
      return {
        issue: { ...normalizeApiIssue(node, workspace), description: node.description ?? '' },
        comments: (node.comments?.nodes ?? [])
          .map((c) => ({ id: c.id, body: c.body ?? '', truncated: false, createdAt: c.createdAt, parentId: c.parent?.id ?? null, user: person(c.user) }))
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
        children: (node.children?.nodes ?? []).map((c) => normalizeApiIssue(c, workspace)),
        relations: [
          ...(node.relations?.nodes ?? []).map((r) => ({ id: r.id, kind: relationKind(r.type, false), issue: linked(r.relatedIssue) })),
          ...(node.inverseRelations?.nodes ?? []).map((r) => ({ id: r.id, kind: relationKind(r.type, true), issue: linked(r.issue) }))
        ],
        attachments: (node.attachments?.nodes ?? []).map((a) => ({ id: a.id, title: a.title ?? a.url, subtitle: a.subtitle ?? null, url: a.url, source: a.sourceType ?? null, createdAt: a.createdAt ?? null })),
        more: { comments: Boolean(node.comments?.pageInfo?.hasNextPage), children: Boolean(node.children?.pageInfo?.hasNextPage) }
      }
    },

    async teamMeta(ws, teamKey) {
      if (typeof teamKey !== 'string' || !/^[A-Za-z0-9]{1,10}$/.test(teamKey)) throw bad('Expected a team key.')
      const data = await call(
        ws,
        `query($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) { nodes {
          states(first: 50) { nodes { id name type color position } }
          members(first: 250) { nodes { id displayName avatarUrl active } }
          labels(first: 250) { nodes { id name color } } } } }`,
        { key: teamKey }
      )
      const team = data.teams?.nodes?.[0]
      if (!team) throw new LinearError('not-found', 'That team was not found.')
      return {
        states: (team.states?.nodes ?? []).map((s) => ({ id: s.id, name: s.name, type: s.type, color: s.color ?? null, position: s.position ?? 0 })).sort((a, b) => a.position - b.position),
        members: (team.members?.nodes ?? []).filter((m) => m.active !== false).map(person),
        labels: (team.labels?.nodes ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color ?? null }))
      }
    },

    async projects(ws) {
      const data = await call(ws, `query { projects(first: 100) { nodes { id name teams(first: 20) { nodes { id } } } } }`)
      return (data.projects?.nodes ?? []).map((p) => ({ id: p.id, name: p.name, workspaceId: ws, teamIds: (p.teams?.nodes ?? []).map((t) => t.id) }))
    },

    async update(ws, key, change) {
      const id = checkKey(key)
      let input
      if ('state' in change) input = { stateId: checkId(change.state.id, 'state') }
      else if ('priority' in change) input = { priority: change.priority }
      else if ('assignee' in change) {
        if (change.assignee === 'me') {
          if (!viewerIds.has(ws)) viewerIds.set(ws, (await call(ws, 'query { viewer { id } }')).viewer.id)
          input = { assigneeId: viewerIds.get(ws) }
        } else input = { assigneeId: change.assignee === null ? null : checkId(change.assignee, 'user') }
      } else throw bad('Nothing to change.')
      const data = await call(ws, 'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id, input })
      if (!data.issueUpdate?.success) throw new LinearError('error', 'Linear did not apply the change.')
    },

    async comment(ws, key, body) {
      const issue = (await call(ws, 'query($id: String!) { issue(id: $id) { id } }', { id: checkKey(key) })).issue
      if (!issue) throw new LinearError('not-found', MESSAGES.notFound)
      const data = await call(ws, 'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId: issue.id, body } })
      if (!data.commentCreate?.success) throw new LinearError('error', 'Linear did not save the comment.')
    }
  }
}

// API keys, one per Linear workspace: the key in `orca.secrets` under `apiKey:<workspace id>`,
// the workspace's name in `orca.storage` under `apiWorkspaces` (no secret there).
export function createApiKeys({ secrets, storage, gql }) {
  const read = async () => {
    const value = await Promise.resolve(storage.get('apiWorkspaces')).catch(() => null)
    return Array.isArray(value) ? value : []
  }
  return {
    list: read,
    get: async (ws) => (await secrets.get(`apiKey:${ws}`)) ?? null,

    // Checks the key against Linear, then stores it for the workspace it belongs to.
    async add(key) {
      const value = typeof key === 'string' ? key.trim() : ''
      if (!/^lin_api_[A-Za-z0-9]{20,80}$/.test(value)) throw bad('That does not look like a Linear personal API key (lin_api_…).')
      const data = await gql(value, 'query { viewer { id } organization { id name urlKey } }')
      const org = data.organization
      await secrets.set(`apiKey:${org.id}`, value)
      const list = (await read()).filter((w) => w.id !== org.id)
      list.push({ id: org.id, name: org.urlKey ?? org.name, urlKey: org.urlKey ?? null })
      await storage.set('apiWorkspaces', list)
      return { id: org.id, name: org.urlKey ?? org.name }
    },

    async remove(ws) {
      await secrets.delete(`apiKey:${checkId(ws, 'workspace')}`)
      await storage.set('apiWorkspaces', (await read()).filter((w) => w.id !== ws))
    }
  }
}
