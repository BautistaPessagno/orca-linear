// One backend over the CLI and the API, chosen per Linear workspace by the `backend` setting:
//   auto (default)  the API for a workspace with an API key, the CLI for the rest
//   cli             the CLI only
//   api             the API only (workspaces with a key)
// Views across every workspace ('all') ask each backend for its share and merge.
import { LinearError, MESSAGES, asLinearError } from './errors.mjs'

export const BACKEND_MODES = Object.freeze(['auto', 'cli', 'api'])

export function createBackendSelector({ cli, api, keys, settings }) {
  const mode = async () => {
    const value = await Promise.resolve(settings.get('backend')).catch(() => undefined)
    return BACKEND_MODES.includes(value) ? value : 'auto'
  }
  const keyed = async () => new Set((await keys.list()).map((w) => w.id))

  const route = async (ws) => {
    const m = await mode()
    if (m === 'cli') return cli
    const hasKey = (await keyed()).has(ws)
    if (m === 'api' && !hasKey) throw new LinearError('not-connected', MESSAGES.notConnected)
    return hasKey ? api : cli
  }

  // Runs `fn` on every share of 'all' and merges. A failing share becomes an error line; only
  // when every share fails does the call fail.
  const fanOut = async (fn, { cliToo = true } = {}) => {
    const m = await mode()
    const apiIds = m === 'cli' ? new Set() : await keyed()
    const jobs = [...apiIds].map((ws) => ({ backend: api, ws }))
    if (m !== 'api' && cliToo) jobs.push({ backend: cli, ws: 'all', exclude: apiIds })
    if (!jobs.length) throw new LinearError(m === 'api' ? 'not-connected' : 'unsupported', m === 'api' ? MESSAGES.notConnected : MESSAGES.cycleNeedsKey)
    const settled = await Promise.allSettled(jobs.map((job) => fn(job.backend, job.ws, job.exclude)))
    const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value)
    const errors = settled.filter((s) => s.status === 'rejected').map((s) => asLinearError(s.reason))
    if (!ok.length) throw errors[0]
    return { ok, errors }
  }

  return {
    mode,

    async workspaces() {
      const m = await mode()
      const list = new Map()
      const errors = []
      if (m !== 'api') {
        try {
          for (const w of await cli.workspaces()) list.set(w.id, { ...w, backend: 'cli', cycles: false })
        } catch (error) {
          errors.push(asLinearError(error))
        }
      }
      if (m !== 'cli') for (const w of await api.workspaces()) list.set(w.id, { ...w, backend: 'api', cycles: true })
      if (!list.size && errors.length) throw errors[0]
      return { workspaces: [...list.values()], errors: errors.map((e) => ({ kind: e.kind, message: e.message })) }
    },

    async teams(ws) {
      if (ws && ws !== 'all') return (await route(ws)).teams(ws)
      const { ok } = await fanOut(async (backend, w, exclude) => (await backend.teams(w)).filter((t) => !exclude?.has(t.workspaceId)))
      return ok.flat()
    },

    async projects(ws) {
      if (ws && ws !== 'all') return (await route(ws)).projects(ws)
      const { ok } = await fanOut(async (backend, w, exclude) => (await backend.projects(w)).filter((p) => !exclude?.has(p.workspaceId)))
      return ok.flat()
    },

    async listIssues(ws, query) {
      if (ws && ws !== 'all') return (await route(ws)).listIssues(ws, query)
      // The CLI cannot tell the current cycle; across workspaces the cycle comes from keyed ones.
      const { ok, errors } = await fanOut(
        async (backend, w, exclude) => {
          const result = await backend.listIssues(w, query)
          return exclude?.size ? { ...result, issues: result.issues.filter((i) => !exclude.has(i.workspace?.id)) } : result
        },
        { cliToo: query.view !== 'cycle' }
      )
      return {
        issues: ok.flatMap((r) => r.issues),
        partial: ok.some((r) => r.partial),
        errors: [...ok.flatMap((r) => r.errors ?? []), ...errors.map((e) => e.message)]
      }
    },

    issue: async (ws, key) => (await route(ws)).issue(ws, key),
    teamMeta: async (ws, teamKey) => (await route(ws)).teamMeta(ws, teamKey),
    update: async (ws, key, change) => (await route(ws)).update(ws, key, change),
    comment: async (ws, key, body) => (await route(ws)).comment(ws, key, body),
    backendFor: async (ws) => (await route(ws)).id
  }
}
