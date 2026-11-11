// Made-up Linear data for screenshots and store images. The worker uses it only while the
// git-ignored file `.scratch/fixtures.json` exists in the plugin folder (see worker.mjs), so a
// screenshot never shows anyone's real issues. Writes change this in-memory data only.
//
// .scratch/fixtures.json: { "route": { "view"?, "issue"?: "ENG-142", "settings"?: true, "text"? },
//                           "focusBranch"?: "pat/eng-142-…", "noKeys"?: true }

const DAY = 86_400_000
const now = Date.now()
const ago = (d) => new Date(now - d * DAY).toISOString()
const inDays = (d) => new Date(now + d * DAY).toISOString().slice(0, 10)

const ACME = { id: 'ws-acme', name: 'acme' }
const SIDE = { id: 'ws-side', name: 'side-project' }
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering', color: '#5e6ad2' }
const DES = { id: 'team-des', key: 'DES', name: 'Design', color: '#d36ec4' }
const SIDE_TEAM = { id: 'team-pet', key: 'PET', name: 'Petri', color: '#4cb782' }

const STATES = {
  triage: { id: 's-tri', name: 'Triage', type: 'triage', color: '#fc7840', position: 0 },
  backlog: { id: 's-bl', name: 'Backlog', type: 'backlog', color: '#bec2c8', position: 1 },
  todo: { id: 's-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 2 },
  progress: { id: 's-ip', name: 'In Progress', type: 'started', color: '#f2c94c', position: 3 },
  review: { id: 's-rev', name: 'In Review', type: 'started', color: '#0f9d58', position: 4 },
  done: { id: 's-done', name: 'Done', type: 'completed', color: '#5e6ad2', position: 5 },
  canceled: { id: 's-can', name: 'Canceled', type: 'canceled', color: '#95a2b3', position: 6 }
}

const PEOPLE = {
  me: { id: 'u-pat', name: 'Pat Rivera', avatarUrl: null },
  sam: { id: 'u-sam', name: 'Sam Okafor', avatarUrl: null },
  lee: { id: 'u-lee', name: 'Lee Tanaka', avatarUrl: null },
  ana: { id: 'u-ana', name: 'Ana Costa', avatarUrl: null }
}

const LABELS = {
  bug: { id: 'l-bug', name: 'Bug', color: '#eb5757' },
  feature: { id: 'l-feat', name: 'Feature', color: '#bb87fc' },
  perf: { id: 'l-perf', name: 'Performance', color: '#4ea7fc' },
  infra: { id: 'l-infra', name: 'Infra', color: '#26b5ce' },
  ux: { id: 'l-ux', name: 'UX', color: '#f2994a' }
}

const PROJECTS = {
  sync: { id: 'p-sync', name: 'Offline sync', color: '#4ea7fc' },
  billing: { id: 'p-bill', name: 'Billing v2', color: '#f2c94c' },
  onboarding: { id: 'p-onb', name: 'Onboarding refresh', color: '#bb87fc' }
}

const CYCLE = { id: 'c-24', number: 24, name: null, startsAt: ago(5), endsAt: inDays(9) }

let n = 0
function make(team, number, title, state, priority, extra = {}) {
  n += 1
  const key = `${team.key}-${number}`
  return {
    id: `fx-${key}`,
    key,
    title,
    url: `https://linear.app/${team === SIDE_TEAM ? 'side-project' : 'acme'}/issue/${key}`,
    workspace: team === SIDE_TEAM ? SIDE : ACME,
    team: { id: team.id, key: team.key, name: team.name, color: team.color },
    state: { id: STATES[state].id, name: STATES[state].name, type: STATES[state].type, color: STATES[state].color },
    priority,
    project: null,
    cycle: null,
    assignee: PEOPLE.me,
    labels: [],
    estimate: null,
    dueDate: null,
    branchName: `pat/${key.toLowerCase()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/-$/, '')}`,
    createdAt: ago(30 - n),
    updatedAt: ago(n * 0.3),
    creator: PEOPLE.me,
    ...extra
  }
}

const ISSUES = [
  make(ENG, 142, 'Retry queued writes after the connection comes back', 'progress', 1, { project: PROJECTS.sync, cycle: CYCLE, labels: [LABELS.bug], estimate: 3, dueDate: inDays(1) }),
  make(ENG, 156, 'Show a conflict banner when two edits collide', 'progress', 2, { project: PROJECTS.sync, cycle: CYCLE, labels: [LABELS.feature, LABELS.ux], estimate: 5 }),
  make(ENG, 131, 'Cut cold start time of the editor by half', 'review', 2, { cycle: CYCLE, labels: [LABELS.perf], estimate: 8 }),
  make(ENG, 160, 'Proration rounding is off by a cent for annual plans', 'todo', 1, { project: PROJECTS.billing, cycle: CYCLE, labels: [LABELS.bug], estimate: 2, dueDate: inDays(-1) }),
  make(ENG, 163, 'Invoice PDF footer overlaps long addresses', 'todo', 3, { project: PROJECTS.billing, labels: [LABELS.bug], estimate: 1 }),
  make(DES, 48, 'Empty states for the new workspace switcher', 'todo', 4, { project: PROJECTS.onboarding, labels: [LABELS.ux] }),
  make(ENG, 118, 'Move preview deploys to the new build cluster', 'backlog', 3, { labels: [LABELS.infra], estimate: 3 }),
  make(ENG, 97, 'Audit log export as CSV', 'backlog', 0, { labels: [LABELS.feature] }),
  make(SIDE_TEAM, 12, 'Plot growth curves per plate', 'progress', 3, { labels: [LABELS.feature], estimate: 2 }),
  make(SIDE_TEAM, 9, 'Calibrate the camera white balance', 'backlog', 4, {}),
  make(ENG, 128, 'Rate limit the public search endpoint', 'done', 2, { labels: [LABELS.infra], updatedAt: ago(2) }),
  make(ENG, 122, 'Flaky test in the sync reconnect suite', 'done', 3, { labels: [LABELS.bug], updatedAt: ago(4) }),
  make(DES, 41, 'Old onboarding illustrations', 'canceled', 0, { updatedAt: ago(6) })
]

const TEAM_BACKLOG = [
  make(ENG, 170, 'Keyboard shortcut to jump to the sync status', 'backlog', 4, { assignee: null, labels: [LABELS.ux] }),
  make(ENG, 171, 'Compress sync payloads over 64 KB', 'backlog', 3, { assignee: PEOPLE.sam, labels: [LABELS.perf], project: PROJECTS.sync }),
  make(ENG, 175, 'Dunning emails for failed renewals', 'backlog', 2, { assignee: null, project: PROJECTS.billing, labels: [LABELS.feature] }),
  make(ENG, 176, 'Crash when a workspace name is empty', 'triage', 1, { assignee: null, labels: [LABELS.bug] }),
  make(ENG, 177, 'Dark mode contrast of the diff gutter', 'triage', 3, { assignee: null, labels: [LABELS.ux] })
]

const CYCLE_OTHERS = [
  make(ENG, 150, 'Background sync for mobile clients', 'progress', 2, { assignee: PEOPLE.sam, cycle: CYCLE, project: PROJECTS.sync, estimate: 5 }),
  make(ENG, 152, 'Tax ID field for EU customers', 'review', 3, { assignee: PEOPLE.lee, cycle: CYCLE, project: PROJECTS.billing, estimate: 2 }),
  make(ENG, 158, 'Telemetry for sync conflicts', 'done', 3, { assignee: PEOPLE.ana, cycle: CYCLE, updatedAt: ago(1), estimate: 1 })
]

const COMMENTS = {
  'ENG-142': [
    { id: 'cm1', body: 'Seeing this on flaky hotel Wi-Fi: the write sits in the queue until a reload. Logs attached in the linked PR.', createdAt: ago(2), parentId: null, user: PEOPLE.sam },
    { id: 'cm2', body: 'Backoff with jitter should do it. I will cap it at **30 s** and keep the order of the queue.', createdAt: ago(1.5), parentId: 'cm1', user: PEOPLE.me },
    { id: 'cm3', body: 'Sounds good. Ping me for review when it is up.', createdAt: ago(0.4), parentId: null, user: PEOPLE.lee }
  ]
}

const DESCRIPTIONS = {
  'ENG-142':
    'When the app goes offline, writes are queued. After the connection comes back, the queue is not retried until the next user action.\n\n## Expected\n\n- Queued writes are retried within a few seconds of reconnecting\n- Order is kept\n- A failed retry backs off instead of looping\n\nSee `SyncQueue.flush()` and the [reconnect notes](https://example.com/notes/reconnect).'
}

function all() {
  return [...ISSUES, ...TEAM_BACKLOG, ...CYCLE_OTHERS]
}

const scoped = (issues, ws, q) =>
  issues.filter((i) => (ws === 'all' || i.workspace.id === ws) && (!q.team || i.team.id === q.team) && (!q.project || i.project?.id === q.project))

export function createFixtureSelector({ config = {} } = {}) {
  const keyed = config.noKeys ? [] : [SIDE]
  return {
    mode: async () => 'auto',
    async workspaces() {
      return { workspaces: [{ ...ACME, backend: 'cli', cycles: false }, { ...SIDE, backend: config.noKeys ? 'cli' : 'api', cycles: !config.noKeys }], errors: [] }
    },
    keys: () => keyed,
    async teams(ws) {
      const teams = [
        { ...ENG, workspaceId: ACME.id, workspaceName: ACME.name },
        { ...DES, workspaceId: ACME.id, workspaceName: ACME.name },
        { ...SIDE_TEAM, workspaceId: SIDE.id, workspaceName: SIDE.name }
      ]
      return ws && ws !== 'all' ? teams.filter((t) => t.workspaceId === ws) : teams
    },
    async projects(ws) {
      return Object.values(PROJECTS).map((p) => ({ id: p.id, name: p.name, workspaceId: ACME.id, teamIds: [ENG.id] })).filter((p) => ws === 'all' || p.workspaceId === ws)
    },
    async listIssues(ws, q) {
      const pool = all()
      let issues
      if (q.view === 'mine') issues = pool.filter((i) => i.assignee?.id === PEOPLE.me.id)
      else if (q.view === 'created') issues = pool.filter((i) => i.creator?.id === PEOPLE.me.id && i.assignee?.id !== PEOPLE.me.id).concat(ISSUES.slice(0, 4))
      else if (q.view === 'backlog') issues = pool.filter((i) => i.state.type === 'backlog')
      else if (q.view === 'triage') issues = pool.filter((i) => i.state.type === 'triage')
      else if (q.view === 'cycle') {
        // As the real selector: cycles only from workspaces with an API key.
        const withKey = keyed.map((w) => w.id)
        if (ws === 'all' ? !withKey.length : !withKey.includes(ws)) throw Object.assign(new Error('The current cycle needs a Linear API key for this workspace. Add one in the panel’s settings.'), { kind: 'unsupported' })
        issues = pool.filter((i) => i.cycle?.id === CYCLE.id && (ws !== 'all' || withKey.includes(i.workspace.id)))
      }
      else issues = pool.filter((i) => `${i.key} ${i.title}`.toLowerCase().includes(String(q.text).toLowerCase()))
      return { issues: scoped(issues, ws, q), partial: false, errors: [] }
    },
    async issue(ws, key) {
      const issue = all().find((i) => i.key === key)
      if (!issue) throw Object.assign(new Error('That issue was not found.'), { kind: 'not-found' })
      const children = key === 'ENG-142' ? [all().find((i) => i.key === 'ENG-122'), make(ENG, 143, 'Keep queue order across app restarts', 'todo', 3, { assignee: PEOPLE.sam })] : []
      return {
        issue: { ...issue, description: DESCRIPTIONS[key] ?? 'Made-up description for a screenshot.' },
        comments: COMMENTS[key] ?? [],
        children,
        relations:
          key === 'ENG-142'
            ? [
                { id: 'r1', kind: 'blocks', issue: { id: 'x', key: 'ENG-150', title: 'Background sync for mobile clients', url: 'https://linear.app/acme/issue/ENG-150' } },
                { id: 'r2', kind: 'relatedTo', issue: { id: 'y', key: 'ENG-156', title: 'Show a conflict banner when two edits collide', url: 'https://linear.app/acme/issue/ENG-156' } }
              ]
            : [],
        attachments: key === 'ENG-142' ? [{ id: 'a1', title: 'Retry queued writes with backoff #812', subtitle: 'Open · 3 files changed', url: 'https://github.com/acme/app/pull/812', source: 'github', createdAt: ago(1) }] : [],
        more: {}
      }
    },
    async teamMeta() {
      return {
        states: Object.values(STATES),
        members: Object.values(PEOPLE),
        labels: Object.values(LABELS)
      }
    },
    async update(ws, key, change) {
      const issue = all().find((i) => i.key === key)
      if (!issue) return
      if (change.state) {
        const s = Object.values(STATES).find((x) => x.id === change.state.id)
        issue.state = { id: s.id, name: s.name, type: s.type, color: s.color }
      }
      if ('priority' in change) issue.priority = change.priority
      if ('assignee' in change) issue.assignee = change.assignee === 'me' ? PEOPLE.me : change.assignee === null ? null : Object.values(PEOPLE).find((p) => p.id === change.assignee)
      issue.updatedAt = new Date().toISOString()
    },
    async comment(ws, key, body) {
      ;(COMMENTS[key] ??= []).push({ id: `cm${Date.now()}`, body, createdAt: new Date().toISOString(), parentId: null, user: PEOPLE.me })
    }
  }
}
