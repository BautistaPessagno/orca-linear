// Made-up Linear data for tests. Nothing here comes from a real workspace.
let n = 0

export const WS_ACME = { id: 'ws-acme', name: 'acme' }
export const WS_HOME = { id: 'ws-home', name: 'home-lab' }
export const TEAM_ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering', color: '#5e6ad2' }

// A normalized issue with sensible defaults; `key` is the identifier.
export function issue(overrides = {}) {
  n += 1
  const key = overrides.key ?? `ENG-${n}`
  const { state, ...rest } = overrides
  return {
    id: `issue-${key}`,
    key,
    title: `Made-up issue ${key}`,
    url: `https://linear.app/acme/issue/${key.toLowerCase()}`,
    workspace: WS_ACME,
    team: TEAM_ENG,
    state: { id: 'state-x', name: 'Todo', type: 'unstarted', color: '#e2e2e2', ...state },
    priority: 3,
    project: null,
    cycle: null,
    assignee: { id: 'user-me', name: 'Pat Example', avatarUrl: null },
    labels: [],
    estimate: null,
    dueDate: null,
    branchName: `pat/${key.toLowerCase()}-made-up`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...rest
  }
}

// One issue row as `orca linear list-issues --json` prints it.
export function cliRow(overrides = {}) {
  return {
    id: 'uuid-1',
    identifier: 'ENG-1',
    title: 'Made-up issue',
    url: 'https://linear.app/acme/issue/ENG-1/made-up-issue',
    description: 'Made-up description',
    state: { name: 'In Progress', type: 'started', color: '#f2c94c', id: 'state-ip' },
    team: { id: 'team-eng', name: 'Engineering', key: 'ENG', color: '#5e6ad2' },
    project: { id: 'proj-1', name: 'Made-up project', color: '#26b5ce' },
    cycle: { id: 'cycle-1', name: null },
    assignee: { id: 'user-me', displayName: 'Pat Example', avatarUrl: 'https://public.linear.app/avatars/pat.png' },
    labels: [{ id: 'label-bug', name: 'Bug', color: '#eb5757' }],
    priority: 2,
    priorityLabel: 'High',
    estimate: 3,
    dueDate: '2026-03-20',
    branchName: 'pat/eng-1-made-up-issue',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    workspace: { id: 'ws-acme', name: 'acme' },
    ...overrides
  }
}
