// The issue shape every backend returns, and the pure logic over it: sorting and grouping the way
// Linear's My Issues does, the issue key in a branch name, due dates and the status bar text.
//
//   Issue {
//     id, key (ENG-123), title, url, workspace { id, name }, team { id, key, name, color },
//     state { id, name, type, color }, priority 0 none | 1 urgent | 2 high | 3 medium | 4 low,
//     project { id, name, color } | null, cycle { id, number, name, startsAt, endsAt } | null,
//     assignee { id, name, avatarUrl } | null, labels [{ id, name, color }],
//     estimate | null, dueDate 'YYYY-MM-DD' | null, branchName, createdAt, updatedAt
//   }

export const STATE_TYPES = Object.freeze(['triage', 'started', 'unstarted', 'backlog', 'completed', 'canceled', 'duplicate'])
export const DONE_TYPES = Object.freeze(['completed', 'canceled', 'duplicate'])
export const PRIORITIES = Object.freeze([
  { value: 0, name: 'No priority' },
  { value: 1, name: 'Urgent' },
  { value: 2, name: 'High' },
  { value: 3, name: 'Medium' },
  { value: 4, name: 'Low' }
])
export const PRIORITY_WORDS = Object.freeze(['none', 'urgent', 'high', 'medium', 'low'])

const DAY = 86_400_000
const SOON_DAYS = 2

export const isOpen = (issue) => !DONE_TYPES.includes(issue?.state?.type)

// Urgent first, then high, medium, low, and no priority last.
const priorityRank = (p) => (p >= 1 && p <= 4 ? p : 5)
const time = (iso) => {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) ? t : 0
}

export function sortIssues(issues) {
  return [...issues].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || time(b.updatedAt) - time(a.updatedAt) || a.key.localeCompare(b.key))
}

// Without the team's state positions, review-like states come after the other started ones,
// which is how most Linear workflows order them.
const guessPosition = (name) => (/review|qa|test|verify/i.test(name) ? 1 : 0)

// Groups by workflow state (merging same-named states of different teams), ordered by state type
// and then the state's position. Completed and canceled work older than `completedDays` is left
// out; what remains of it is collapsed. `progress` is how far along a started state is (0–1), for
// the status glyph.
export function groupIssues(issues, { now = Date.now(), completedDays = 14, positions = {} } = {}) {
  const cutoff = now - completedDays * DAY
  const groups = new Map()
  for (const issue of issues) {
    const type = STATE_TYPES.includes(issue.state?.type) ? issue.state.type : 'unstarted'
    if (DONE_TYPES.includes(type) && time(issue.updatedAt) < cutoff) continue
    const name = issue.state?.name || type
    const id = `${type}:${name.toLowerCase()}`
    let group = groups.get(id)
    if (!group) {
      group = { id, type, name, color: issue.state?.color ?? null, issues: [], collapsed: DONE_TYPES.includes(type) }
      groups.set(id, group)
    }
    group.issues.push(issue)
  }
  const position = (g) => (Number.isFinite(positions[g.name]) ? positions[g.name] : guessPosition(g.name) * 1000)
  const list = [...groups.values()].sort(
    (a, b) => STATE_TYPES.indexOf(a.type) - STATE_TYPES.indexOf(b.type) || position(a) - position(b) || a.name.localeCompare(b.name)
  )
  const started = list.filter((g) => g.type === 'started')
  for (const g of list) {
    g.issues = sortIssues(g.issues)
    g.progress = g.type === 'started' ? (started.indexOf(g) + 1) / (started.length + 1) : g.type === 'completed' ? 1 : 0
  }
  return list
}

// Linear's progress for a state: what the status glyph fills. Started states without a known
// order sit at half.
export function stateProgress(state, startedNames = []) {
  if (state?.type === 'completed') return 1
  if (state?.type !== 'started') return 0
  const i = startedNames.indexOf(state.name)
  return i < 0 ? 0.5 : (i + 1) / (startedNames.length + 1)
}

const KEY = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})(?=$|[^0-9])/g

// The Linear issue key in a branch name: `pat/eng-123-fix` → ENG-123. With `teamKeys`, only a key
// of one of those teams counts.
export function keyFromBranch(branch, teamKeys) {
  if (typeof branch !== 'string' || !branch) return null
  const known = Array.isArray(teamKeys) && teamKeys.length ? new Set(teamKeys.map((k) => k.toUpperCase())) : null
  for (const match of branch.matchAll(KEY)) {
    const team = match[1].toUpperCase()
    if (!known || known.has(team)) return `${team}-${match[2]}`
  }
  return null
}

// 'overdue' before today, 'soon' within two days, else null. Dates are calendar days in UTC, as
// Linear stores them.
export function dueState(dueDate, now = Date.now()) {
  if (typeof dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(dueDate)) return null
  const due = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`)
  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z')
  if (due < today) return 'overdue'
  if (due - today <= SOON_DAYS * DAY) return 'soon'
  return null
}

export function matchesText(issue, text) {
  const q = String(text ?? '').trim().toLowerCase()
  if (!q) return true
  const hay = [issue.key, issue.title, issue.project?.name, issue.team?.key, ...(issue.labels ?? []).map((l) => l.name)].filter(Boolean).join('\n').toLowerCase()
  return q.split(/\s+/).every((word) => hay.includes(word))
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// What the status bar item says for my issues; null hides it.
export function statusBarView(issues) {
  const inProgress = issues.filter((i) => i.state?.type === 'started').length
  const urgent = issues.filter((i) => isOpen(i) && i.priority === 1).length
  if (!inProgress && !urgent) return null
  const parts = []
  if (inProgress) parts.push(`${inProgress} in progress`)
  if (urgent) parts.push(`${urgent} urgent`)
  return {
    text: parts.join(' · '),
    icon: 'activity',
    tone: urgent ? 'warning' : 'neutral',
    tooltip: `Linear: ${plural(inProgress, 'issue')} in progress, ${plural(urgent, 'urgent issue')} open`
  }
}
