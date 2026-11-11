// "Start work" on an issue from the panel. An Orca workspace whose branch carries the issue key
// (or is the issue's own branch name) opens with `workspace.open`. Otherwise a new worktree is
// made with `orca worktree create --linear-issue`, run from the focused workspace's folder so
// Orca picks that repository; there is no host method to create one.
import { LinearError, bad } from './errors.mjs'
import { keyFromBranch } from './model.mjs'
import { checkKey } from '../backends/cli.mjs'

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/

export function createStartWork({ host, run }) {
  const list = async () => (await host.call('workspace.list')).workspaces ?? []

  const matches = (workspace, key, branchName) => {
    if (!workspace.branch) return false
    const branch = workspace.branch.replace(/^refs\/heads\//, '')
    return keyFromBranch(branch, [key.split('-')[0]]) === key || (branchName && branch.toLowerCase() === branchName.toLowerCase())
  }

  const focusedWorkspace = async (all) => {
    const context = await host.call('workspace.readContext')
    if (!context?.branch) return null
    const branch = context.branch.replace(/^refs\/heads\//, '')
    return all.find((w) => w.branch && w.branch.replace(/^refs\/heads\//, '') === branch && w.name === context.displayName) ?? all.find((w) => w.branch?.replace(/^refs\/heads\//, '') === branch) ?? null
  }

  return {
    // The workspaces already on this issue, and whether a new one can be made here.
    async find({ key, branchName } = {}) {
      const id = checkKey(key)
      const all = await list()
      const focused = await focusedWorkspace(all)
      return {
        workspaces: all.filter((w) => matches(w, id, branchName)).map((w) => ({ id: w.id, name: w.name, branch: w.branch, project: w.project ?? null })),
        canCreate: Boolean(focused && focused.kind === 'worktree'),
        repository: focused?.project ?? null
      }
    },

    async open({ workspaceId } = {}) {
      if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 512) throw bad('Pick a workspace to open.')
      if (!(await list()).some((w) => w.id === workspaceId)) throw bad('That workspace is gone.')
      await host.call('workspace.open', { workspaceId })
      return { opened: true }
    },

    async start({ key, branchName } = {}) {
      const id = checkKey(key)
      if (branchName != null && (typeof branchName !== 'string' || !BRANCH.test(branchName) || branchName.includes('..'))) throw bad('That branch name is not usable.')
      const all = await list()
      const existing = all.find((w) => matches(w, id, branchName))
      if (existing) {
        await host.call('workspace.open', { workspaceId: existing.id })
        return { opened: true, created: false, workspace: existing.name }
      }
      const focused = await focusedWorkspace(all)
      if (!focused || focused.kind !== 'worktree' || !focused.path) throw new LinearError('invalid', 'Focus a workspace of the repository first; the new one is made from it.')
      const args = ['worktree', 'create', '--name', id.toLowerCase(), '--linear-issue', id, '--no-parent', '--activate']
      if (branchName) args.push('--branch', branchName)
      const result = await run(args, { cwd: focused.path })
      return { opened: true, created: true, workspace: result?.worktree?.name ?? result?.name ?? id.toLowerCase() }
    }
  }
}
