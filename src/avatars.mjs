// Avatars for the panel, which has no network: the worker fetches them and hands back `data:`
// URLs. Only URLs the worker itself handed out in Linear data are fetched (never an arbitrary
// URL from the panel), over https, as an image, at most MAX_BYTES; the last CACHE are kept.
const MAX_BYTES = 48 * 1024
const CACHE = 128
const KNOWN = 2048

export function createAvatars({ fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const known = new Set()
  const cache = new Map()

  const load = async (url) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    if (!response.ok) return null
    const type = String(response.headers.get('content-type') ?? '').split(';')[0].trim()
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(type)) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_BYTES) return null
    return `data:${type};base64,${bytes.toString('base64')}`
  }

  return {
    // Records the avatar URLs in any Linear data on its way to the panel.
    remember(value) {
      const visit = (v) => {
        if (!v || typeof v !== 'object') return
        if (Array.isArray(v)) return v.forEach(visit)
        for (const [k, x] of Object.entries(v)) {
          if (k === 'avatarUrl' && typeof x === 'string' && x.startsWith('https://')) {
            known.add(x)
            if (known.size > KNOWN) known.delete(known.values().next().value)
          } else if (x && typeof x === 'object') visit(x)
        }
      }
      visit(value)
      return value
    },

    async get(url) {
      if (typeof url !== 'string' || !known.has(url)) return null
      let job = cache.get(url)
      if (job) cache.delete(url)
      else job = load(url).catch(() => null)
      cache.set(url, job)
      if (cache.size > CACHE) cache.delete(cache.keys().next().value)
      return job
    }
  }
}
