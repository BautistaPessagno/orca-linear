// Keeps "My issues" across every workspace fresh while the plugin is enabled (the status bar item
// keeps the worker running), and from each fresh list:
//   - the status bar item: "3 in progress · 1 urgent", hidden when there is nothing to say;
//   - a desktop notification per open issue newly assigned to me, when `notifyAssigned` is on.
//     The ids seen last are kept in storage, so a restart does not notify again; the first poll
//     ever only records.
import { isOpen, statusBarView } from './model.mjs'

export const ITEM_ID = 'linear'
export const MINE = Object.freeze({ view: 'mine', workspace: 'all', team: null, project: null })
const SEEN = 'seenAssigned'
const MAX_NOTIFY = 3
const RETRY_MS = 60_000

const minutes = (value, fallback) => (Number.isFinite(value) && value >= 1 && value <= 60 ? value : fallback)

export function createPoller({ store, host, settings, storage, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null
  let stopped = true
  let shown

  const setting = async (key) => Promise.resolve(settings.get(key)).catch(() => undefined)

  const show = async (view) => {
    const key = JSON.stringify(view)
    if (key === shown) return
    shown = key
    try {
      await host.call('statusBar.update', view ? { id: ITEM_ID, visible: true, ...view } : { id: ITEM_ID, visible: false })
    } catch (error) {
      log(`status bar: ${error.code ?? error.message}`)
    }
  }

  const notifyNew = async (issues) => {
    const open = issues.filter(isOpen)
    const before = await Promise.resolve(storage.get(SEEN)).catch(() => null)
    await storage.set(SEEN, open.map((i) => i.id))
    if (!Array.isArray(before) || (await setting('notifyAssigned')) !== true) return
    const seen = new Set(before)
    const fresh = open.filter((i) => !seen.has(i.id))
    for (const issue of fresh.slice(0, MAX_NOTIFY)) {
      await host.call('notifications.show', { title: `Assigned to you: ${issue.key}`, body: issue.title.slice(0, 200) }).catch((error) => log(`notify: ${error.code ?? error.message}`))
    }
    if (fresh.length > MAX_NOTIFY) await host.call('notifications.show', { title: `${fresh.length - MAX_NOTIFY} more Linear issues assigned to you` }).catch(() => {})
  }

  // Called with every fresh "My issues" list, whoever fetched it.
  const onMine = async (issues) => {
    await show(statusBarView(issues))
    await notifyNew(issues)
  }

  const schedule = (ms) => {
    if (stopped) return
    clearTimer(timer)
    timer = setTimer(tick, ms)
    timer?.unref?.()
  }

  const tick = async () => {
    timer = null
    if (stopped) return
    const every = minutes(await setting('refreshMinutes'), 5) * 60_000
    try {
      await store.refresh(MINE, { force: true })
      schedule(every)
    } catch (error) {
      log(`refresh: ${error.message}`)
      schedule(Math.min(every, error.retryAfterMs ?? RETRY_MS))
    }
  }

  return {
    onMine,
    async start() {
      if (!stopped) return
      stopped = false
      // Show the last known count at once, then refresh.
      const cached = await store.cached(MINE).catch(() => null)
      if (cached?.issues) await show(statusBarView(cached.issues))
      schedule(0)
    },
    stop() {
      stopped = true
      clearTimer(timer)
      timer = null
    }
  }
}
