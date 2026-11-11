// Linear Issues panel. Talks only to its own worker (`orca.plugin.request`); everything from
// Linear is untrusted text and reaches the page through textContent. Glyph SVG strings come from
// glyphs.mjs, built from numbers and checked colours only.
import { DONE_TYPES, PRIORITIES, dueState, groupIssues, isOpen, matchesText, stateProgress } from '../src/model.mjs'
import { ICONS, color, priorityGlyph, setLightTheme, statusGlyph } from './glyphs.mjs'
import { parseMarkdown } from './markdown.mjs'

const $ = (id) => document.getElementById(id)

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k === 'svg') el.innerHTML = v // only glyphs.mjs output
    else if (k === 'style') el.style.cssText = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}
const glyph = (svg, cls) => h('span', { class: cls, svg, 'aria-hidden': 'true' })

// ---------- worker bridge ----------
async function request(name, input) {
  const out = await (input === undefined ? orca.plugin.request(name) : orca.plugin.request(name, input, { timeoutMs: 90_000 }))
  if (out && typeof out === 'object' && out.error && !Array.isArray(out)) {
    throw Object.assign(new Error(out.error.message), { kind: out.error.kind, retryAfterMs: out.error.retryAfterMs })
  }
  return out
}

// ---------- state ----------
const VIEWS = [
  { id: 'mine', label: 'My issues' },
  { id: 'cycle', label: 'Cycle' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'created', label: 'Created' },
  { id: 'triage', label: 'Triage' }
]
const DEFAULT_UI = { workspace: 'all', view: 'mine', team: null, project: null, collapsed: {} }

const state = {
  app: null,
  ui: { ...DEFAULT_UI },
  allTeams: [],
  projects: [],
  metas: new Map(),
  list: null,
  listError: null,
  loading: false,
  refreshing: false,
  text: '',
  search: null,
  selected: -1,
  route: { name: 'list' },
  detail: null,
  detailError: null,
  work: null,
  scroll: 0
}

let saveTimer = null
function saveUi() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => orca.storage.set('ui', state.ui).catch(() => {}), 300)
}

// ---------- formatting ----------
const PALETTE = ['#5e6ad2', '#26b5ce', '#4cb782', '#f2994a', '#d36ec4', '#eb5757', '#bb87fc', '#4ea7fc', '#0f9d58', '#e5732e']
function hue(text) {
  let x = 0
  for (const ch of String(text ?? '')) x = (x * 31 + ch.codePointAt(0)) >>> 0
  return PALETTE[x % PALETTE.length]
}
const initials = (name) =>
  String(name ?? '?')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function ago(iso) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  const d = new Date(t)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}
function dueLabel(due) {
  const day = Date.parse(`${due}T00:00:00Z`)
  const today = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')
  const diff = Math.round((day - today) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  const d = new Date(day)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}
const cycleLabel = (c) => (c?.number ? `Cycle ${c.number}` : c?.name || 'Cycle')
const RELATION_NAMES = { blocks: 'Blocks', blockedBy: 'Blocked by', relatedTo: 'Related', duplicateOf: 'Duplicate of', duplicatedBy: 'Duplicated by', similarTo: 'Similar' }

// ---------- avatars ----------
const avatarCache = new Map()
const avatarWaiters = new Map()
let avatarActive = 0
const avatarQueue = []
function pumpAvatars() {
  while (avatarActive < 4 && avatarQueue.length) {
    const url = avatarQueue.shift()
    avatarActive++
    request('avatar', { url })
      .then((r) => avatarCache.set(url, r?.dataUrl ?? null))
      .catch(() => avatarCache.set(url, null))
      .finally(() => {
        avatarActive--
        for (const img of avatarWaiters.get(url) ?? []) if (avatarCache.get(url)) setImg(img, avatarCache.get(url))
        avatarWaiters.delete(url)
        pumpAvatars()
      })
  }
}
function setImg(box, src) {
  box.textContent = ''
  box.style.background = 'none'
  box.append(h('img', { src, alt: '' }))
}
function avatar(person, { big = false } = {}) {
  if (!person) return h('span', { class: `avatar none${big ? ' big' : ''}`, svg: ICONS.person, title: 'No assignee' })
  const box = h('span', { class: `avatar${big ? ' big' : ''}`, style: `background:${hue(person.name)}`, title: person.name, text: initials(person.name) })
  const url = person.avatarUrl
  if (url) {
    if (avatarCache.get(url)) setImg(box, avatarCache.get(url))
    else if (!avatarCache.has(url)) {
      if (!avatarWaiters.has(url)) {
        avatarWaiters.set(url, [])
        avatarQueue.push(url)
      }
      avatarWaiters.get(url).push(box)
      pumpAvatars()
    }
  }
  return box
}

// ---------- workspace helpers ----------
const workspaces = () => state.app?.workspaces ?? []
const workspaceName = (id) => (id === 'all' ? 'All workspaces' : workspaces().find((w) => w.id === id)?.name ?? id)
const teamsHere = () => state.allTeams.filter((t) => state.ui.workspace === 'all' || t.workspaceId === state.ui.workspace)
const teamById = (id) => state.allTeams.find((t) => t.id === id)
const metaKey = (ws, team) => `${ws}|${team}`

async function teamMeta(ws, teamKey) {
  const id = metaKey(ws, teamKey)
  if (!state.metas.has(id)) state.metas.set(id, request('team.meta', { workspace: ws, team: teamKey }).catch((e) => (state.metas.delete(id), Promise.reject(e))))
  return state.metas.get(id)
}

// Started states in workflow order, from what is known: for the status glyph's fill.
const startedOrder = new Map()
function noteStates(teamKey, states) {
  startedOrder.set(teamKey, states.filter((s) => s.type === 'started').map((s) => s.name))
}

const triageShown = () => {
  if (state.ui.view === 'triage') return true
  if (state.allTeams.some((t) => t.triage)) return true
  const team = teamById(state.ui.team)
  return Boolean(team && team.hasTriage)
}

// ---------- loading ----------
let listSeq = 0
async function loadList({ quiet = false, force = false } = {}) {
  const seq = ++listSeq
  if (!quiet) {
    state.loading = !state.list
    state.listError = null
  }
  state.refreshing = true
  renderChrome()
  if (!quiet && !state.list) renderMain()
  try {
    const result = await request('issues.list', { view: state.ui.view, workspace: state.ui.workspace, team: state.ui.team, project: state.ui.project, force })
    if (seq !== listSeq) return
    state.list = result
    state.listError = null
    state.refreshing = Boolean(result.stale)
  } catch (error) {
    if (seq !== listSeq) return
    state.listError = error
    state.list = null
    state.refreshing = false
  }
  state.loading = false
  renderChrome()
  if (state.route.name === 'list') renderMain()
}

async function loadTeams() {
  try {
    state.allTeams = await request('teams.list', { workspace: 'all' })
  } catch {
    state.allTeams = []
  }
  await loadProjects()
  renderChrome()
}

async function loadProjects() {
  try {
    state.projects = await request('projects.list', { workspace: state.ui.workspace })
  } catch {
    state.projects = []
  }
}

async function loadTeamMetaForFilter() {
  const team = teamById(state.ui.team)
  if (!team) return
  try {
    const meta = await teamMeta(team.workspaceId, team.key)
    noteStates(team.key, meta.states)
    team.hasTriage = meta.states.some((s) => s.type === 'triage')
    team.positions = Object.fromEntries(meta.states.map((s) => [s.name, s.position]))
    renderChrome()
    if (state.route.name === 'list') renderMain()
  } catch {
    // The list still works without positions.
  }
}

// ---------- chrome: header, focus strip, footer ----------
function renderChrome() {
  const ws = state.ui.workspace
  const name = workspaceName(ws)
  const wsBtn = $('ws')
  wsBtn.replaceChildren(
    h('span', { class: 'mark', style: `background:${ws === 'all' ? 'linear-gradient(135deg,#5e6ad2,#26b5ce)' : hue(name)}`, text: ws === 'all' ? '∗' : name[0]?.toUpperCase() ?? '?' }),
    h('span', { class: 'name', text: name }),
    glyph(ICONS.chevronDown)
  )

  const refresh = $('refresh')
  refresh.innerHTML = ICONS.refresh
  refresh.classList.toggle('spin', state.refreshing)
  $('gear').innerHTML = ICONS.gear
  $('search-icon').innerHTML = ICONS.search

  const tabs = $('tabs')
  tabs.replaceChildren(
    ...VIEWS.filter((v) => v.id !== 'triage' || triageShown()).map((v) =>
      h('button', { class: 'tab', role: 'tab', 'aria-selected': String(state.ui.view === v.id), text: v.label, onclick: () => setView(v.id) })
    )
  )

  const team = teamById(state.ui.team)
  const teamChip = $('team-chip')
  teamChip.classList.toggle('on', Boolean(team))
  teamChip.replaceChildren(h('span', { text: team ? team.key : 'Team' }), glyph(ICONS.chevronDown))
  teamChip.title = team ? `Team: ${team.name}` : 'Filter by team'
  const project = state.projects.find((p) => p.id === state.ui.project)
  const projectChip = $('project-chip')
  projectChip.classList.toggle('on', Boolean(project))
  projectChip.replaceChildren(h('span', { text: project ? project.name : 'Project' }), glyph(ICONS.chevronDown))
  projectChip.title = project ? `Project: ${project.name}` : 'Filter by project'

  renderFocus()
  renderFooter()
}

function focusIssue() {
  const key = state.app?.focus?.key
  if (!key) return null
  return state.list?.issues?.find((i) => i.key === key) ?? null
}

function renderFocus() {
  const el = $('focus')
  const focus = state.app?.focus
  if (!focus?.key || state.route.name !== 'list') return (el.hidden = true)
  const issue = focusIssue()
  el.hidden = false
  el.replaceChildren(
    h(
      'span',
      { class: 'what' },
      h('span', { class: 'eyebrow' }, glyph(ICONS.branch), 'This workspace'),
      h(
        'span',
        { class: 'line' },
        issue ? glyph(statusGlyph(issue.state?.type, issue.state?.color, stateProgress(issue.state, startedOrder.get(issue.team?.key)))) : null,
        h('b', { class: 'num', text: focus.key }),
        h('span', { class: 'title', text: issue ? issue.title : focus.branch })
      )
    )
  )
  el.onclick = () => {
    const team = state.allTeams.find((t) => t.key === focus.key.split('-')[0])
    const workspace = issue?.workspace?.id ?? team?.workspaceId
    if (workspace) openIssue({ key: focus.key, workspace: { id: workspace } })
    else toast(`No connected Linear workspace has the team ${focus.key.split('-')[0]}.`, true)
  }
}

function renderFooter() {
  const footer = $('footer')
  const list = state.list
  const errors = [...(state.app?.errors ?? []).map((e) => e.message), ...(list?.errors ?? [])]
  const warn = errors.length > 0 || list?.partial
  let text
  if (state.route.name === 'settings') text = 'Connection and API keys'
  else if (state.loading) text = 'Loading from Linear…'
  else if (list?.at) text = `${state.refreshing ? 'Refreshing · ' : ''}Updated ${ago(new Date(list.at).toISOString())}`
  else text = state.refreshing ? 'Refreshing…' : ''
  if (warn) text += errors.length ? ` · ${errors[0]}` : ' · Some issues not shown'
  footer.replaceChildren(h('i', { class: `dot${warn ? ' warn' : ''}` }), h('span', { text, title: errors.join('\n') }), h('span', { class: 'keys', text: state.route.name === 'list' ? 'j/k ↵ / r' : 'esc' }))
}

// ---------- list ----------
function visibleIssues() {
  if (state.search) return state.search.issues
  return (state.list?.issues ?? []).filter((i) => matchesText(i, state.text))
}

let rowIssues = []
function renderMain() {
  const main = $('main')
  if (state.route.name === 'issue') return renderDetail()
  if (state.route.name === 'settings') return renderSettings()
  rowIssues = []
  const nodes = []

  if (state.loading && !state.list) {
    for (let i = 0; i < 9; i++) nodes.push(h('div', { class: 'skel' }, h('i'), h('i'), h('i'), h('i', { style: `width:${55 + ((i * 37) % 40)}%` })))
    main.replaceChildren(...nodes)
    return
  }
  if (state.listError) {
    main.replaceChildren(errorState(state.listError))
    return
  }

  if (state.list?.partial) nodes.push(h('div', { class: 'notice', text: 'Linear sent part of this list. Narrow it with a team or project to see the rest.' }))

  const issues = visibleIssues()
  if (state.search) {
    nodes.push(groupHead({ id: 'search', name: `Results for “${state.search.text}”`, type: 'unstarted', issues }, false, true))
    for (const issue of issues) nodes.push(issueRow(issue))
    if (!issues.length) nodes.push(h('div', { class: 'empty' }, h('p', { text: 'Nothing in Linear matches that.' })))
  } else if (!issues.length) {
    nodes.push(emptyState())
  } else {
    const team = teamById(state.ui.team)
    const groups = groupIssues(issues, { completedDays: 3650, positions: team?.positions ?? {} })
    for (const group of groups) {
      const collapsed = state.ui.collapsed[group.id] ?? group.collapsed
      nodes.push(groupHead(group, collapsed))
      if (!collapsed) for (const issue of group.issues) nodes.push(issueRow(issue, group))
    }
    if (state.text.trim()) nodes.push(h('button', { class: 'more-row', onclick: runSearch }, glyph(ICONS.search), `Search all of Linear for “${state.text.trim()}”`, h('kbd', { class: 'num', text: '↵', style: 'margin-left:auto;color:var(--subtle)' })))
  }
  main.replaceChildren(...nodes)
  if (state.selected >= rowIssues.length) state.selected = rowIssues.length - 1
  markSelected(false)
}

function groupHead(group, collapsed, flat = false) {
  const progress = group.type === 'started' ? group.progress : group.type === 'completed' ? 1 : 0
  return h(
    'button',
    {
      class: 'group-head',
      'aria-expanded': String(!collapsed),
      onclick: flat
        ? () => clearSearch()
        : () => {
            state.ui.collapsed[group.id] = !collapsed
            saveUi()
            renderMain()
          }
    },
    flat ? glyph(ICONS.close) : glyph(ICONS.chevronDown, 'chev'),
    flat ? glyph(ICONS.search) : glyph(statusGlyph(group.type, group.color, progress)),
    h('span', { text: group.name }),
    h('span', { class: 'count num', text: String(group.issues.length) })
  )
}

function issueRow(issue, group) {
  const index = rowIssues.push(issue) - 1
  const due = issue.dueDate && isOpen(issue) ? dueState(issue.dueDate) : null
  const meta = [
    ...issue.labels.slice(0, 3).map((l) => h('span', { class: 'label' }, h('i', { style: `background:${color(l.color, '#8a8f98')}` }), h('span', { text: l.name }))),
    issue.labels.length > 3 ? h('span', { class: 'tag', text: `+${issue.labels.length - 3}` }) : null,
    issue.project ? h('span', { class: 'tag', title: `Project: ${issue.project.name}` }, glyph(ICONS.project), h('span', { text: issue.project.name })) : null,
    issue.cycle ? h('span', { class: 'tag', title: 'Cycle' }, glyph(ICONS.cycle), h('span', { text: cycleLabel(issue.cycle) })) : null,
    issue.estimate != null ? h('span', { class: 'tag num', title: `Estimate: ${issue.estimate}` }, glyph(ICONS.estimate), h('span', { text: String(issue.estimate) })) : null,
    issue.dueDate ? h('span', { class: `tag num${due ? ` ${due}` : ''}`, title: `Due ${issue.dueDate}` }, glyph(ICONS.calendar), h('span', { text: dueLabel(issue.dueDate) })) : null
  ].filter(Boolean)
  const here = state.app?.focus?.key === issue.key
  const done = DONE_TYPES.includes(issue.state?.type)
  return h(
    'button',
    {
      class: `row${here ? ' here' : ''}${done ? ' done' : ''}`,
      'data-index': index,
      title: here ? `${issue.key} · the issue of this workspace` : issue.key,
      onclick: () => {
        state.selected = index
        openIssue(issue)
      }
    },
    glyph(priorityGlyph(issue.priority), 'prio'),
    h('span', { class: 'id', text: issue.key }),
    glyph(statusGlyph(issue.state?.type, issue.state?.color, stateProgress(issue.state, startedOrder.get(issue.team?.key) ?? []) || group?.progress)),
    h('span', { class: 'title', text: issue.title }),
    here ? glyph(ICONS.branch, 'here-mark') : avatar(issue.assignee),
    meta.length ? h('span', { class: 'meta' }, meta) : null
  )
}

function markSelected(scroll = true) {
  for (const el of document.querySelectorAll('.row.sel')) el.classList.remove('sel')
  if (state.selected < 0) return
  const el = document.querySelector(`.row[data-index="${state.selected}"]`)
  if (!el) return
  el.classList.add('sel')
  if (scroll) el.scrollIntoView({ block: 'nearest' })
}

const EMPTY_ART = `<svg width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="7" y="9" width="30" height="26" rx="5"/><path d="M7 17 H37"/><circle cx="13" cy="25" r="2.5"/><path d="M19 25 H31"/><circle cx="13" cy="30.5" r="1" fill="currentColor"/></svg>`

function emptyState() {
  if (state.text.trim()) return h('div', { class: 'empty' }, h('h3', { text: 'No issues match' }), h('p', { text: 'Press Enter to search all of Linear instead.' }))
  const words = {
    mine: ['Nothing assigned to you', 'Issues assigned to you in any connected workspace show up here.'],
    cycle: ['Nothing in the current cycle', 'The active cycle of the selected team has no issues.'],
    backlog: ['The backlog is empty', 'Issues in a Backlog state show up here.'],
    created: ['You have not created issues', 'Issues you open in Linear show up here.'],
    triage: ['Triage is clear', 'New issues that need a first look show up here.']
  }[state.ui.view]
  return h('div', { class: 'empty' }, h('span', { class: 'art', svg: EMPTY_ART }), h('h3', { text: words[0] }), h('p', { text: words[1] }))
}

function errorState(error) {
  if (error.kind === 'unsupported') {
    return h(
      'div',
      { class: 'empty' },
      h('span', { class: 'art', svg: EMPTY_ART }),
      h('h3', { text: 'The cycle needs a Linear API key' }),
      h('p', { text: 'Orca’s Linear connection doesn’t say which cycle is current. Add a personal API key for the workspace to see it here.' }),
      h('button', { class: 'btn primary', onclick: () => go({ name: 'settings' }) }, glyph(ICONS.key), 'Add an API key')
    )
  }
  return h(
    'div',
    { class: 'empty' },
    h('h3', { text: error.kind === 'no-cli' ? 'Orca’s command line tool was not found' : error.kind === 'not-connected' ? 'Linear is not connected' : 'Linear did not answer' }),
    h('p', { text: error.message }),
    h('div', { style: 'display:flex;gap:6px' }, h('button', { class: 'btn', onclick: () => loadList({ force: true }) }, 'Try again'), h('button', { class: 'btn', onclick: () => go({ name: 'settings' }) }, 'Connection'))
  )
}

// ---------- actions ----------
function setView(view) {
  if (state.ui.view === view) return
  state.ui.view = view
  state.list = null
  state.search = null
  state.selected = -1
  saveUi()
  go({ name: 'list' })
  loadList()
}

function setFilter(patch) {
  Object.assign(state.ui, patch)
  if ('team' in patch && patch.team) {
    const team = teamById(patch.team)
    if (team && state.ui.workspace !== 'all' && team.workspaceId !== state.ui.workspace) state.ui.workspace = team.workspaceId
  }
  if (state.ui.view === 'triage' && !triageShown()) state.ui.view = 'mine'
  state.list = null
  state.search = null
  state.selected = -1
  saveUi()
  renderChrome()
  loadList()
  if (patch.team) loadTeamMetaForFilter()
}

async function runSearch() {
  const text = state.text.trim()
  if (!text) return
  state.refreshing = true
  renderChrome()
  try {
    const result = await request('issues.search', { workspace: state.ui.workspace, team: state.ui.team, text })
    state.search = { text, issues: result.issues }
    state.selected = result.issues.length ? 0 : -1
  } catch (error) {
    toast(error.message, true)
  }
  state.refreshing = false
  renderChrome()
  renderMain()
}

function clearSearch() {
  state.search = null
  state.text = ''
  $('search').value = ''
  state.selected = -1
  renderMain()
}

function go(route) {
  if (state.route.name === 'list') state.scroll = $('main').scrollTop
  state.route = route
  document.body.classList.toggle('sub', route.name !== 'list')
  closeMenu()
  renderChrome()
  renderMain()
  if (route.name === 'list') $('main').scrollTop = state.scroll
  else $('main').scrollTop = 0
}

async function openIssue(issue) {
  const ws = issue.workspace?.id
  if (!ws) return
  state.detail = issue.title ? { issue, comments: null, children: [], relations: [], attachments: [] } : null
  state.detailError = null
  state.work = null
  go({ name: 'issue', workspace: ws, key: issue.key })
  try {
    const cached = await request('issue.get', { workspace: ws, key: issue.key, cached: true })
    if (state.route.key !== issue.key) return
    state.detail = cached
    renderMain()
    if (cached.cached) {
      const fresh = await request('issue.get', { workspace: ws, key: issue.key })
      if (state.route.key !== issue.key) return
      state.detail = fresh
      renderMain()
    }
  } catch (error) {
    if (state.route.key !== issue.key) return
    state.detailError = error
    renderMain()
  }
  const detail = state.detail?.issue
  if (detail?.team?.key) teamMeta(ws, detail.team.key).then((meta) => noteStates(detail.team.key, meta.states)).catch(() => {})
  request('work.find', { key: issue.key, branchName: detail?.branchName ?? issue.branchName ?? null })
    .then((work) => {
      if (state.route.key !== issue.key) return
      state.work = work
      renderMain()
    })
    .catch(() => {})
}

function openExternal(url) {
  if (!url || !/^https?:\/\//i.test(url)) return
  Promise.resolve(orca.shell?.openExternal?.(url)).catch(() => toast('Orca could not open the link.', true))
}

async function change(kind, value) {
  const route = state.route
  const issue = state.detail?.issue
  if (!issue) return
  try {
    state.detail = await request('issue.update', { workspace: route.workspace, key: route.key, team: issue.team?.key, change: { [kind]: value } })
    renderMain()
    const what = kind === 'state' ? `Status set to ${state.detail.issue.state?.name}` : kind === 'priority' ? `Priority set to ${PRIORITIES[value].name}` : value ? `Assigned to ${state.detail.issue.assignee?.name ?? 'you'}` : 'Unassigned'
    toast(`${route.key}: ${what}`)
  } catch (error) {
    toast(error.message, true)
  }
}

// ---------- detail ----------
function renderDetail() {
  const main = $('main')
  const route = state.route
  const d = state.detail
  const issue = d?.issue
  const crumbs = h(
    'div',
    { class: 'crumbs' },
    h('button', { class: 'icon-btn', title: 'Back (Esc)', 'aria-label': 'Back', svg: ICONS.back, onclick: () => go({ name: 'list' }) }),
    h('span', { class: 'path' }, h('span', { text: workspaceName(route.workspace) }), h('span', { text: '›' }), h('b', { text: route.key })),
    h('span', { class: 'spacer' }),
    issue?.url ? h('button', { class: 'btn', title: 'Open in Linear (O)', onclick: () => openExternal(issue.url) }, glyph(ICONS.external), 'Open in Linear') : null
  )
  if (state.detailError) {
    main.replaceChildren(crumbs, h('div', { class: 'empty' }, h('h3', { text: 'Could not open the issue' }), h('p', { text: state.detailError.message })))
    return
  }
  if (!issue) {
    main.replaceChildren(crumbs, ...Array.from({ length: 6 }, (_, i) => h('div', { class: 'skel' }, h('i'), h('i'), h('i'), h('i', { style: `width:${50 + i * 7}%` }))))
    return
  }
  const progress = stateProgress(issue.state, startedOrder.get(issue.team?.key) ?? [])
  const due = issue.dueDate && isOpen(issue) ? dueState(issue.dueDate) : null
  const props = h(
    'dl',
    { class: 'props' },
    h('dt', { text: 'Status' }),
    h('dd', {}, h('button', { class: 'prop', id: 'p-status', title: 'Change status (S)', onclick: (e) => statusMenu(e.currentTarget) }, glyph(statusGlyph(issue.state?.type, issue.state?.color, progress)), h('span', { text: issue.state?.name ?? '—' }))),
    h('dt', { text: 'Priority' }),
    h('dd', {}, h('button', { class: 'prop', id: 'p-priority', title: 'Change priority (P)', onclick: (e) => priorityMenu(e.currentTarget) }, glyph(priorityGlyph(issue.priority)), h('span', { text: PRIORITIES[issue.priority]?.name ?? 'No priority' }))),
    h('dt', { text: 'Assignee' }),
    h('dd', {}, h('button', { class: `prop${issue.assignee ? '' : ' quiet'}`, id: 'p-assignee', title: 'Change assignee (A)', onclick: (e) => assigneeMenu(e.currentTarget) }, avatar(issue.assignee), h('span', { text: issue.assignee?.name ?? 'Unassigned' }))),
    issue.labels.length ? [h('dt', { text: 'Labels' }), h('dd', {}, issue.labels.map((l) => h('span', { class: 'label' }, h('i', { style: `background:${color(l.color, '#8a8f98')}` }), h('span', { text: l.name }))))] : null,
    issue.project ? [h('dt', { text: 'Project' }), h('dd', {}, h('span', { class: 'prop' }, h('i', { svg: ICONS.project, style: `color:${color(issue.project.color, 'var(--muted)')}` }), h('span', { text: issue.project.name })))] : null,
    issue.cycle ? [h('dt', { text: 'Cycle' }), h('dd', {}, h('span', { class: 'prop' }, glyph(ICONS.cycle), h('span', { text: cycleLabel(issue.cycle) + (issue.cycle.endsAt ? ` · ends ${dueLabel(issue.cycle.endsAt.slice(0, 10))}` : '') })))] : null,
    issue.estimate != null ? [h('dt', { text: 'Estimate' }), h('dd', {}, h('span', { class: 'prop num' }, glyph(ICONS.estimate), h('span', { text: `${issue.estimate} point${issue.estimate === 1 ? '' : 's'}` })))] : null,
    issue.dueDate ? [h('dt', { text: 'Due date' }), h('dd', {}, h('span', { class: `prop num tag${due ? ` ${due}` : ''}` }, glyph(ICONS.calendar), h('span', { text: dueLabel(issue.dueDate) + (due === 'overdue' ? ' · overdue' : '') })))] : null
  )

  const work = state.work
  let workRow = null
  if (work?.workspaces?.length) {
    workRow = h('div', { class: 'work' }, work.workspaces.slice(0, 3).map((w) => h('button', { class: 'btn', title: `Open the Orca workspace on ${w.branch}`, onclick: () => startWork('open', w.id) }, glyph(ICONS.branch), `Open ${w.name}`)))
  } else if (work?.canCreate) {
    workRow = h(
      'div',
      { class: 'work' },
      h('button', { class: 'btn', title: `New Orca workspace on ${issue.branchName ?? issue.key}`, onclick: () => startWork('start') }, glyph(ICONS.branch), 'Start in a new workspace'),
      work.repository ? h('span', { class: 'hint', text: `from ${work.repository}` }) : null
    )
  }

  const parts = []
  parts.push(h('section', { class: 'part' }, h('div', { class: 'md' }, issue.description?.trim() ? renderMarkdown(issue.description) : h('p', { class: 'placeholder', text: 'No description.' }))))

  if (d.children?.length) {
    const doneCount = d.children.filter((c) => c.state?.type === 'completed').length
    parts.push(h('section', { class: 'part' }, h('h4', {}, 'Sub-issues', h('span', { class: 'count num', text: `${doneCount}/${d.children.length}` })), d.children.map((c) => miniRow(c, null, route.workspace))))
  }
  if (d.relations?.length) {
    parts.push(h('section', { class: 'part' }, h('h4', {}, 'Relations'), d.relations.map((r) => miniRow(r.issue, RELATION_NAMES[r.kind] ?? r.kind, route.workspace))))
  }
  if (d.attachments?.length) {
    parts.push(
      h(
        'section',
        { class: 'part' },
        h('h4', {}, 'Links', h('span', { class: 'count num', text: String(d.attachments.length) })),
        d.attachments.map((a) => h('button', { class: 'attach', title: a.url, onclick: () => openExternal(a.url) }, h('span', { class: 'ico', svg: ICONS.link }), h('span', { style: 'display:grid;min-width:0' }, h('span', { class: 't', text: a.title }), h('span', { class: 's', text: [a.source, a.subtitle].filter(Boolean).join(' · ') || hostOf(a.url) }))))
      )
    )
  }
  parts.push(commentsPart(d))

  main.replaceChildren(h('div', { class: 'detail' }, crumbs, h('h2', { class: 'd-title', text: issue.title }), props, workRow, parts))
}

const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function miniRow(target, kind, workspace) {
  const full = target.state ? target : null
  return h(
    'button',
    { class: 'mini', onclick: () => openIssue({ ...target, workspace: target.workspace ?? { id: workspace } }) },
    full ? glyph(statusGlyph(full.state.type, full.state.color, stateProgress(full.state, startedOrder.get(full.team?.key) ?? []))) : glyph(ICONS.link),
    h('span', { class: 'id', text: target.key }),
    h('span', { class: 'title', text: target.title }),
    kind ? h('span', { class: 'kind', text: kind }) : full ? avatar(full.assignee) : null
  )
}

function commentsPart(d) {
  const comments = d.comments ?? []
  const top = comments.filter((c) => !c.parentId || !comments.some((x) => x.id === c.parentId))
  const repliesOf = (id) => comments.filter((c) => c.parentId === id)
  const one = (c, reply) =>
    h(
      'div',
      { class: `comment${reply ? ' reply' : ''}` },
      avatar(c.user, { big: true }),
      h('div', { style: 'min-width:0' }, h('div', { class: 'who' }, h('b', { text: c.user?.name ?? 'Someone' }), h('time', { text: ago(c.createdAt), title: c.createdAt })), h('div', { class: 'md' }, renderMarkdown(c.body + (c.truncated ? '\n\n…' : ''))))
    )
  const textarea = h('textarea', { id: 'comment', placeholder: 'Leave a comment…', rows: '3', 'aria-label': 'Comment' })
  const send = h('button', { class: 'btn primary', disabled: true }, 'Comment')
  textarea.addEventListener('input', () => {
    send.disabled = !textarea.value.trim()
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(220, textarea.scrollHeight)}px`
  })
  const submit = async () => {
    const body = textarea.value.trim()
    if (!body || send.disabled) return
    send.disabled = true
    textarea.disabled = true
    try {
      state.detail = await request('issue.comment', { workspace: state.route.workspace, key: state.route.key, body })
      toast('Comment added')
      renderMain()
      $('main').scrollTop = $('main').scrollHeight
    } catch (error) {
      toast(error.message, true)
      send.disabled = false
      textarea.disabled = false
    }
  }
  send.addEventListener('click', submit)
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  })
  return h(
    'section',
    { class: 'part' },
    h('h4', {}, 'Activity', d.comments ? h('span', { class: 'count num', text: comments.length ? `${comments.length} comment${comments.length === 1 ? '' : 's'}` : '' }) : null),
    d.comments === null ? h('div', { class: 'skel' }, h('i'), h('i'), h('i'), h('i')) : top.map((c) => [one(c, false), repliesOf(c.id).map((r) => one(r, true))]),
    h('div', { class: 'composer' }, textarea, h('div', { class: 'actions' }, h('small', { text: '⌘↵ to send' }), send))
  )
}

function renderInline(nodes) {
  return nodes.map((n) => {
    if (n.t === 'text') return n.text
    if (n.t === 'code') return h('code', { text: n.text })
    if (n.t === 'link') return h('a', { href: '#', title: n.href, onclick: (e) => (e.preventDefault(), openExternal(n.href)) }, n.text)
    return h({ b: 'strong', i: 'em', s: 's' }[n.t] ?? 'span', {}, renderInline(n.children ?? []))
  })
}

function renderMarkdown(text) {
  return parseMarkdown(text).map((b) => {
    switch (b.type) {
      case 'h':
        return h(`h${Math.min(6, b.level)}`, {}, renderInline(b.inline))
      case 'ul':
      case 'ol':
        return h(b.type, {}, b.items.map((it) => h('li', { class: it.checked === null ? null : 'task', style: it.depth ? `margin-left:${it.depth * 14}px` : null }, it.checked === null ? null : h('span', { text: it.checked ? '☑' : '☐' }), h('span', {}, renderInline(it.inline)))))
      case 'quote':
        return h('blockquote', {}, renderInline(b.inline))
      case 'code':
        return h('pre', {}, h('code', { text: b.text, style: 'background:none;border:0;padding:0' }))
      case 'hr':
        return h('hr')
      default:
        return h('p', {}, renderInline(b.inline))
    }
  })
}

async function startWork(kind, workspaceId) {
  const issue = state.detail?.issue
  try {
    const result = kind === 'open' ? await request('work.open', { workspaceId }) : await request('work.start', { key: issue.key, branchName: issue.branchName ?? null })
    toast(result.created ? `Made the workspace ${result.workspace}` : 'Opened the workspace')
  } catch (error) {
    toast(error.message, true)
  }
}

// ---------- settings ----------
function renderSettings() {
  const main = $('main')
  const app = state.app
  const keyed = new Set((app?.keys ?? []).map((k) => k.id))
  const msg = h('div', { class: 'form-msg', text: '' })
  const input = h('input', { id: 'api-key', type: 'password', placeholder: 'lin_api_…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Linear API key' })
  const add = h('button', { class: 'btn primary' }, 'Add key')
  const submit = async () => {
    const key = input.value.trim()
    if (!key) return
    add.disabled = true
    msg.className = 'form-msg'
    msg.textContent = 'Checking the key with Linear…'
    try {
      const ws = await request('keys.add', { key })
      input.value = ''
      await reloadApp()
      toast(`API key added for ${ws.name}`)
      renderMain()
    } catch (error) {
      msg.className = 'form-msg error'
      msg.textContent = error.message
      add.disabled = false
    }
  }
  add.addEventListener('click', submit)
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit())
  const mode = { auto: 'Auto', cli: 'Orca’s Linear connection only', api: 'Linear API keys only' }[app?.mode] ?? 'Auto'

  main.replaceChildren(
    h('div', { class: 'crumbs' }, h('button', { class: 'icon-btn', title: 'Back (Esc)', 'aria-label': 'Back', svg: ICONS.back, onclick: () => go({ name: 'list' }) }), h('span', { class: 'path' }, h('b', { text: 'Connection' }))),
    h(
      'div',
      { class: 'settings' },
      h('div', { style: 'display:grid;gap:6px' }, h('h3', { text: 'Linear workspaces' }), h('p', { text: `Read through Orca’s own Linear connection, or a personal API key where you added one. Mode: ${mode} (Orca → Settings → Plugins → Linear Issues).` })),
      h(
        'div',
        { style: 'display:grid;gap:6px' },
        workspaces().length
          ? workspaces().map((w) =>
              h(
                'div',
                { class: 'wsrow' },
                h('span', { class: 'mark', style: `background:${hue(w.name)}`, text: w.name[0]?.toUpperCase() ?? '?' }),
                h('span', { style: 'display:grid;min-width:0' }, h('span', { class: 'n', text: w.name }), h('span', { class: 'via', text: w.backend === 'api' ? 'API key · cycles on' : 'Orca’s Linear connection' })),
                keyed.has(w.id) ? h('button', { class: 'btn', title: 'Forget this API key', onclick: () => removeKey(w) }, 'Remove key') : h('span', { class: 'badge', text: 'Connected' })
              )
            )
          : h('p', { text: 'No Linear workspace is connected yet. Connect Linear in Orca’s settings, or add an API key below.' })
      ),
      h(
        'div',
        { style: 'display:grid;gap:8px' },
        h('h3', { text: 'Add an API key' }),
        h('p', { text: 'A personal API key adds the current cycle and reads a view in one request. Make one in Linear under Settings → Security & access, one per workspace. It stays in Orca’s encrypted secrets.' }),
        h('div', { class: 'keyform' }, input, add),
        msg,
        h('div', {}, h('button', { class: 'linkish', onclick: () => openExternal('https://linear.app/settings/account/security') }, 'Open Linear’s API key settings'))
      )
    )
  )
}

async function removeKey(w) {
  try {
    await request('keys.remove', { workspace: w.id })
    await reloadApp()
    toast(`Removed the API key for ${w.name}`)
    renderMain()
  } catch (error) {
    toast(error.message, true)
  }
}

// ---------- menus ----------
let menu = null
function closeMenu() {
  if (!menu) return
  menu.el.remove()
  const anchor = menu.anchor
  menu = null
  anchor?.setAttribute?.('aria-expanded', 'false')
  anchor?.focus?.({ preventScroll: true })
}

// items: [{ value, label, icon?, hint?, selected?, head? }]
function openMenu(anchor, items, onPick, { filter = items.length > 7, placeholder = 'Filter…' } = {}) {
  closeMenu()
  const el = h('div', { class: 'menu', role: 'menu' })
  const list = h('div', { class: 'items' })
  const input = filter ? h('input', { placeholder, 'aria-label': placeholder }) : null
  if (input) el.append(h('div', { class: 'filter' }, glyph(ICONS.search), input))
  el.append(list)
  let shown = []
  let active = 0
  const draw = () => {
    const q = (input?.value ?? '').trim().toLowerCase()
    shown = items.filter((it) => !it.head && (!q || it.label.toLowerCase().includes(q)))
    active = Math.max(0, Math.min(active, shown.length - 1))
    const nodes = []
    for (const it of items) {
      if (it.head) {
        if (!q) nodes.push(h('div', { class: 'head', text: it.label }))
        continue
      }
      const i = shown.indexOf(it)
      if (i < 0) continue
      nodes.push(
        h(
          'button',
          { class: `item${i === active ? ' active' : ''}`, role: 'menuitem', onmousemove: () => i !== active && ((active = i), draw()), onclick: () => pick(it) },
          it.icon instanceof Node ? it.icon : it.icon ? glyph(it.icon) : h('span'),
          h('span', { text: it.label }),
          it.selected ? glyph(ICONS.check, 'check') : it.hint ? h('small', { text: it.hint }) : h('span')
        )
      )
    }
    if (!shown.length) nodes.push(h('div', { class: 'none', text: 'No match' }))
    list.replaceChildren(...nodes)
    list.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' })
  }
  const pick = (it) => {
    closeMenu()
    onPick(it.value)
  }
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'j' && !input)) active = Math.min(shown.length - 1, active + 1)
    else if (e.key === 'ArrowUp' || (e.key === 'k' && !input)) active = Math.max(0, active - 1)
    else if (e.key === 'Enter') return e.preventDefault(), shown[active] && pick(shown[active])
    else if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), closeMenu()
    else return
    e.preventDefault()
    draw()
  })
  input?.addEventListener('input', () => ((active = 0), draw()))
  document.body.append(el)
  active = Math.max(0, items.filter((it) => !it.head).findIndex((it) => it.selected))
  draw()
  const r = anchor.getBoundingClientRect()
  const w = el.offsetWidth
  const hgt = el.offsetHeight
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`
  el.style.top = `${r.bottom + 4 + hgt > window.innerHeight - 8 ? Math.max(8, r.top - hgt - 4) : r.bottom + 4}px`
  anchor.setAttribute('aria-expanded', 'true')
  menu = { el, anchor }
  ;(input ?? list.querySelector('.item') ?? el).focus()
  if (!input) el.tabIndex = -1
  if (!input) el.focus()
}

document.addEventListener('mousedown', (e) => {
  if (menu && !menu.el.contains(e.target) && !menu.anchor.contains(e.target)) closeMenu()
})

function workspaceMenu(anchor) {
  const items = [{ value: 'all', label: 'All workspaces', selected: state.ui.workspace === 'all', icon: h('span', { class: 'avatar', style: 'background:linear-gradient(135deg,#5e6ad2,#26b5ce);border-radius:4px', text: '∗' }) }]
  for (const w of workspaces()) items.push({ value: w.id, label: w.name, hint: w.backend === 'api' ? 'API' : '', selected: state.ui.workspace === w.id, icon: h('span', { class: 'avatar', style: `background:${hue(w.name)};border-radius:4px`, text: w.name[0]?.toUpperCase() ?? '?' }) })
  openMenu(anchor, items, async (value) => {
    const team = teamById(state.ui.team)
    const patch = { workspace: value }
    if (team && value !== 'all' && team.workspaceId !== value) patch.team = null
    patch.project = null
    state.ui.workspace = value
    await loadProjects()
    setFilter(patch)
  })
}

function teamMenu(anchor) {
  const items = [{ value: null, label: 'All teams', selected: !state.ui.team, icon: ICONS.close }]
  const multi = workspaces().length > 1 && state.ui.workspace === 'all'
  for (const t of teamsHere()) items.push({ value: t.id, label: `${t.name}`, hint: multi ? `${t.key} · ${t.workspaceName ?? ''}` : t.key, selected: state.ui.team === t.id, icon: h('span', { class: 'avatar', style: `background:${color(t.color, hue(t.name))};border-radius:4px;width:14px;height:14px;font-size:8px`, text: t.key[0] }) })
  openMenu(anchor, items, (value) => setFilter({ team: value, project: null }))
}

function projectMenu(anchor) {
  const team = teamById(state.ui.team)
  const projects = state.projects.filter((p) => !team || !p.teamIds?.length || p.teamIds.includes(team.id))
  const items = [{ value: null, label: 'All projects', selected: !state.ui.project, icon: ICONS.close }]
  for (const p of projects) items.push({ value: p.id, label: p.name, selected: state.ui.project === p.id, icon: ICONS.project })
  openMenu(anchor, items, (value) => setFilter({ project: value }), { filter: true, placeholder: 'Find a project…' })
}

async function statusMenu(anchor) {
  const issue = state.detail?.issue
  if (!issue?.team) return
  try {
    const meta = await teamMeta(state.route.workspace, issue.team.key)
    noteStates(issue.team.key, meta.states)
    const started = meta.states.filter((s) => s.type === 'started').map((s) => s.name)
    const items = meta.states.map((s, i) => ({ value: s.name, label: s.name, hint: String(i + 1), selected: s.name === issue.state?.name, icon: statusGlyph(s.type, s.color, stateProgress(s, started)) }))
    openMenu(anchor, items, (value) => value !== issue.state?.name && change('state', value), { filter: true, placeholder: 'Change status…' })
  } catch (error) {
    toast(error.message, true)
  }
}

function priorityMenu(anchor) {
  const issue = state.detail?.issue
  const order = [0, 1, 2, 3, 4]
  openMenu(anchor, order.map((p) => ({ value: p, label: PRIORITIES[p].name, hint: String(p), selected: issue?.priority === p, icon: priorityGlyph(p) })), (value) => value !== issue?.priority && change('priority', value), { filter: false })
}

async function assigneeMenu(anchor) {
  const issue = state.detail?.issue
  if (!issue?.team) return
  try {
    const meta = await teamMeta(state.route.workspace, issue.team.key)
    const items = [
      { value: null, label: 'No assignee', selected: !issue.assignee, icon: avatar(null) },
      { value: 'me', label: 'Assign to me', icon: ICONS.person },
      { head: true, label: 'Team members' },
      ...meta.members.map((m) => ({ value: m.id, label: m.name, selected: issue.assignee?.id === m.id, icon: avatar(m) }))
    ]
    openMenu(anchor, items, (value) => change('assignee', value), { filter: true, placeholder: 'Assign to…' })
  } catch (error) {
    toast(error.message, true)
  }
}

// ---------- toast ----------
let toastTimer = null
function toast(text, error = false) {
  document.querySelector('.toast')?.remove()
  const el = h('div', { class: `toast${error ? ' error' : ''}`, role: 'status' }, h('span', { text }))
  document.body.append(el)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), error ? 6000 : 3000)
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (menu) return
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')
  if (e.key === 'Escape') {
    if (typing) return document.activeElement.blur()
    if (state.route.name !== 'list') return go({ name: 'list' })
    if (state.search || state.text) return clearSearch()
    return
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (state.route.name === 'list') {
    if (e.key === 'j' || e.key === 'ArrowDown') state.selected = Math.min(rowIssues.length - 1, state.selected + 1)
    else if (e.key === 'k' || e.key === 'ArrowUp') state.selected = Math.max(0, state.selected - 1)
    else if (e.key === 'Enter' && rowIssues[state.selected]) return openIssue(rowIssues[state.selected])
    else if (e.key === 'o' && rowIssues[state.selected]?.url) return openExternal(rowIssues[state.selected].url)
    else if (e.key === '/') return e.preventDefault(), $('search').focus()
    else if (e.key === 'r') return loadList({ quiet: true, force: true })
    else if (/^[1-5]$/.test(e.key)) {
      const views = VIEWS.filter((v) => v.id !== 'triage' || triageShown())
      return views[Number(e.key) - 1] && setView(views[Number(e.key) - 1].id)
    } else return
    e.preventDefault()
    markSelected()
  } else if (state.route.name === 'issue') {
    const issue = state.detail?.issue
    if (e.key === 'o' && issue?.url) openExternal(issue.url)
    else if (e.key === 's') $('p-status')?.click()
    else if (e.key === 'p') $('p-priority')?.click()
    else if (e.key === 'a') $('p-assignee')?.click()
    else if (e.key === 'c') return e.preventDefault(), $('comment')?.focus()
    else if (e.key === 'Backspace') go({ name: 'list' })
  }
})

// ---------- wiring ----------
$('ws').addEventListener('click', (e) => workspaceMenu(e.currentTarget))
$('team-chip').addEventListener('click', (e) => teamMenu(e.currentTarget))
$('project-chip').addEventListener('click', (e) => projectMenu(e.currentTarget))
$('refresh').addEventListener('click', () => (state.route.name === 'issue' ? openIssue({ ...state.detail?.issue, workspace: { id: state.route.workspace } }) : loadList({ quiet: true, force: true })))
$('gear').addEventListener('click', () => go(state.route.name === 'settings' ? { name: 'list' } : { name: 'settings' }))
$('search').addEventListener('input', (e) => {
  state.text = e.target.value
  state.search = null
  state.selected = state.text ? 0 : -1
  if (state.route.name !== 'list') go({ name: 'list' })
  else renderMain()
})
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    runSearch()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    $('search').blur()
    state.selected = Math.max(0, state.selected)
    markSelected()
  }
})

async function reloadApp() {
  try {
    state.app = await request('app.state')
  } catch (error) {
    state.app = { workspaces: [], errors: [{ message: error.message }], keys: [], focus: null }
  }
  renderChrome()
}

orca.plugin.on('issues.changed', ({ key } = {}) => {
  if (key === '*' || key === state.list?.key) loadList({ quiet: true })
})
orca.plugin.on('issues.failed', ({ key, message, kind } = {}) => {
  state.refreshing = false
  if (key !== state.list?.key) return renderChrome()
  if (['unsupported', 'not-connected', 'unauthenticated', 'no-cli'].includes(kind)) {
    state.list = null
    state.listError = Object.assign(new Error(message), { kind })
  } else if (state.list) state.list.errors = [message]
  renderChrome()
  if (state.route.name === 'list') renderMain()
})
orca.on?.('workspace.changed', async () => {
  try {
    const focus = await request('focus.get')
    if (state.app) state.app.focus = focus
    renderChrome()
    if (state.route.name === 'list') renderMain()
  } catch {
    // Keep the last one.
  }
})
// The relative times in the footer.
setInterval(() => state.route.name === 'list' && renderFooter(), 30_000)

function applyTheme() {
  setLightTheme(document.documentElement.classList.contains('light'))
}
orca.on?.('theme', () => {
  applyTheme()
  renderChrome()
  renderMain()
})

async function start() {
  applyTheme()
  const saved = await orca.storage.get('ui').catch(() => null)
  if (saved && typeof saved === 'object') state.ui = { ...DEFAULT_UI, ...saved, collapsed: { ...(saved.collapsed ?? {}) } }
  renderChrome()
  renderMain()
  await reloadApp()
  const ids = new Set(workspaces().map((w) => w.id))
  if (state.ui.workspace !== 'all' && !ids.has(state.ui.workspace)) state.ui.workspace = 'all'
  const dev = state.app?.dev
  if (dev?.view) state.ui.view = dev.view
  if (dev?.team !== undefined) state.ui.team = dev.team
  if (dev?.workspace) state.ui.workspace = dev.workspace
  const listing = loadList()
  await loadTeams()
  if (state.ui.team) loadTeamMetaForFilter()
  await listing
  if (dev?.text) {
    state.text = dev.text
    $('search').value = dev.text
    renderMain()
  }
  if (dev?.settings) go({ name: 'settings' })
  if (dev?.issue) {
    const team = state.allTeams.find((t) => t.key === dev.issue.split('-')[0])
    if (team) await openIssue({ key: dev.issue, workspace: { id: team.workspaceId } })
  }
  if (dev?.scroll) $('main').scrollTop = dev.scroll
  if (dev?.menu) $(`p-${dev.menu}`)?.click()
  if (dev?.selected !== undefined) {
    state.selected = dev.selected
    markSelected()
  }
}

start()
