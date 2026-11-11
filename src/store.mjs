// Issue lists cached in orca.storage, so the panel opens on the last answer while a fresh one
// loads behind it. A list answered from the cache comes back `stale: true`; the refresh it starts
// posts `issues.changed` with the list's key when done, and the panel asks again.
//
// Refreshes of one list share a promise, and a list fetched in the last MIN_AGE_MS is not
// fetched again unless forced. At most MAX_LISTS lists are kept, least recently used dropped.
const PREFIX = 'cache:'
const INDEX = 'cache:index'
const MAX_LISTS = 24
const MIN_AGE_MS = 15_000

export const listKey = ({ view, workspace = 'all', team = null, project = null }) => `${view}|${workspace}|${team ?? ''}|${project ?? ''}`

export function createIssueStore({ storage, fetchList, post = () => {}, now = Date.now, onFresh = () => {} }) {
  const inflight = new Map()
  const fetchedAt = new Map()

  const index = async () => {
    const value = await Promise.resolve(storage.get(INDEX)).catch(() => null)
    return Array.isArray(value) ? value : []
  }
  const touch = async (key) => {
    const keys = (await index()).filter((k) => k !== key)
    keys.unshift(key)
    for (const old of keys.splice(MAX_LISTS)) await storage.delete(PREFIX + old)
    await storage.set(INDEX, keys)
  }

  const refresh = (params, { force = false } = {}) => {
    const key = listKey(params)
    if (inflight.has(key)) return inflight.get(key)
    if (!force && fetchedAt.has(key) && now() - fetchedAt.get(key) < MIN_AGE_MS) return null
    const job = (async () => {
      try {
        const result = await fetchList(params)
        const entry = { issues: result.issues, partial: Boolean(result.partial), errors: result.errors ?? [], at: now() }
        fetchedAt.set(key, entry.at)
        await storage.set(PREFIX + key, entry)
        await touch(key)
        onFresh(params, entry)
        return entry
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, job)
    return job
  }

  return {
    refresh,

    async list(params, { force = false } = {}) {
      const key = listKey(params)
      const cached = force ? null : await Promise.resolve(storage.get(PREFIX + key)).catch(() => null)
      if (cached?.issues) {
        const job = refresh(params)
        if (!job) return { ...cached, key, stale: false }
        job.then(() => post('issues.changed', { key })).catch((error) => post('issues.failed', { key, message: error.message }))
        return { ...cached, key, stale: true }
      }
      const fresh = await refresh(params, { force: true })
      return { ...fresh, key, stale: false }
    },

    cached: async (params) => (await Promise.resolve(storage.get(PREFIX + listKey(params))).catch(() => null)) ?? null,

    // After a write: every list may have changed. Forget when they were fetched so the next ask
    // refreshes, and tell open panels.
    invalidate() {
      fetchedAt.clear()
      post('issues.changed', { key: '*' })
    }
  }
}
