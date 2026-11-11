# Reaching Linear from an Orca plugin worker

Research for the Linear Issues plugin, done on Orca 1.4.256 (macOS) on 2026-11-11. Sources: the
`orca linear` CLI's own `--help` and JSON output (read-only commands only), the authoring guide
bundled with this Orca (`orca skills get orca-plugin-authoring`), a probe handler run inside a
dev-loaded worker, and Linear's developer docs (linked per section). No issue content from the
real workspaces is copied here; shapes only.

## 1. How a worker finds `orca`

A probe handler (`orca plugin dev request . diag`) inside the worker reported:

| Fact | Value |
| --- | --- |
| `process.execPath` | `/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper` |
| `process.versions` | Node 24.22, Electron 43 |
| `cwd` | `/` |
| Environment | only `ELECTRON_RUN_AS_NODE`, `HOME`, `PATH`, `TMPDIR`, `__CF_USER_TEXT_ENCODING` |
| `PATH` | the user's login `PATH` (included `/usr/local/bin`, where the installer links `orca`) |
| `ORCA_CLI_BIN_DIR` | not set (it is set in Orca terminals, not in workers) |

`/Applications/Orca.app/Contents/Resources/bin/orca` is a bash launcher that runs the CLI with
Orca's own Electron in Node mode (`ELECTRON_RUN_AS_NODE=1`). Running it from the worker with
`execFile` works: `--version` and `linear team list --json` both answered.

So the plugin resolves the executable in this order, and checks each candidate with `--version`:

1. The `orcaPath` setting, when the user set one.
2. Derived from `process.execPath`: cut at the first `*.app/` and append
   `Contents/Resources/bin/orca` (macOS). On Linux and Windows Electron keeps `resources/` next to
   the executable: `<dir of execPath>/resources/bin/orca` (`orca.cmd` on Windows). This finds the
   CLI of the very Orca that runs the worker, also for a copy outside `/Applications`.
3. `orca` on `PATH`.
4. Well-known places: `/Applications/Orca.app/Contents/Resources/bin/orca`,
   `~/Applications/Orca.app/...`, `/usr/local/bin/orca`, `~/.local/bin/orca`.

## 2. What the `orca linear` CLI gives

Every command takes `--json` and answers `{ id, ok, result, _meta }`, or `{ ok: false, error: { code, message } }`.

### Reads used by the plugin

| Command | Returns | Time (one call) |
| --- | --- | --- |
| `team list --workspace all` | `teams[]: { id, name, key, url, workspace: { id, name } }`; meta `partial`, `workspaceErrors` | ~0.5 s |
| `list-issues --assignee me --workspace all` (no `--limit`) | every match; 223 issues in ~1.6 s | 1–2 s |
| `list-issues ... --limit n --workspace <id>` | `meta.hasMore`, `meta.nextCursor` (`orca.linear.v1.…`) | ~1 s |
| `list --filter created --workspace all` | lighter rows (no labels, cycle, branch) | ~0.6 s |
| `issue <key> --comments --children --relations --attachments` | issue plus sections, each with `returned`, `cap`, `hasMore` | ~2 s |
| `team states --team <key> --workspace <id>` | `states[]: { id, name, type, color, position }` | ~0.5 s |
| `team members`, `team labels` | `{ id, displayName, avatarUrl }`, `{ id, name, color }` | ~0.5 s |
| `project list --workspace all` | `{ id, name, url, workspaceId, workspaceName, teams[] }` | ~0.5 s |

An issue row from `list-issues`:

```
id, identifier, title, url, description,
state { id, name, type, color }, team { id, name, key, color },
project { id, name, color } | null, cycle { id, name } | null,
assignee { id, displayName, avatarUrl } | null, labels[] { id, name, color },
priority (0 none, 1 urgent, 2 high, 3 medium, 4 low), priorityLabel,
estimate | null, dueDate | null, branchName, createdAt, updatedAt, workspace { id, name }
```

Detail sections: comments `{ id, body, bodyTruncated, createdAt, updatedAt, parentId, user }`;
children are issue rows plus `mayHaveMore`; relations `{ id, type, direction, relationship,
relatedIssue { id, identifier, title, url } }`; attachments `{ id, title, url, subtitle, source,
createdAt }`.

Filters that work: `--assignee me|null|<user>`, `--state <name or type>` (`started`, `backlog`
and `In Review` all matched), `--team <key>` together with `--workspace <id>` (without it the
team is looked up in the default workspace only and returns nothing), `--project`, `--query`,
`--cycle <cycle id>`.

### Where the CLI falls short

- **Cycles.** A row carries `cycle: { id, name: null }`: no number, no dates. `--cycle current`,
  `active` and `next` return nothing; only a cycle id filters. There is no cycle list command, so
  the CLI cannot say which cycle is current. The plugin's Current cycle view needs the API backend.
- **Triage.** Only visible through `team states` (a state of type `triage`); none of the teams
  checked had one. Triage is shown only for teams that have that state.
- **Who "me" is.** No viewer command. `--assignee me` works, but the plugin cannot tell which
  member is the user, so "Assign to me" uses `assignee set --me`.
- **Pagination.** Only with a single `--workspace`; with `--workspace all` there is no cursor.
  Without `--limit` it returns everything, which is fast enough for one person's issues.
- **Speed.** Each call starts a CLI process (~0.5 s floor). The plugin batches with
  `--workspace all`, runs calls in parallel and caches results.
- **Priority set** takes `none|low|medium|high|urgent`; **status set** takes the exact state
  name; **assignee set** takes `--me` or `--to-id <userId>`; **comment add** takes
  `--body-file -` for multi-line text on stdin. None of these were run against real workspaces.

## 3. Linear's GraphQL API (second backend)

From Linear's developer docs:

- Endpoint `https://api.linear.app/graphql`; introspection is supported.
  ([GraphQL](https://linear.app/developers/graphql))
- A personal API key goes in `Authorization: <API_KEY>`, **without** `Bearer`; OAuth tokens use
  `Bearer`. Keys are made under Settings → Security & access. A key belongs to one workspace, so
  two workspaces need two keys.
- Check the `errors` array even on HTTP 200; partial failures happen.
- Relay pagination: `first`/`after`, `pageInfo { hasNextPage endCursor }`, 50 by default;
  `orderBy: updatedAt` puts recent changes first. ([Pagination](https://linear.app/developers/pagination))
- Filters: comparators `eq`, `neq`, `in`, `nin`, `containsIgnoreCase`; fields AND together, `or:
  [...]` for OR; `state: { type: { eq: "started" } }`; `viewer { assignedIssues }` and
  `viewer { createdIssues }`. ([Filtering](https://linear.app/developers/filtering))
- Rate limits for API keys: 2,500 requests and 3,000,000 complexity points per hour per user,
  10,000 points per query. Over the limit: HTTP 429, `extensions.code: RATELIMITED`,
  `Retry-After` in seconds. Headers `X-RateLimit-Requests-Remaining` and friends.
  ([Rate limiting](https://linear.app/developers/rate-limiting))

Schema fields the plugin uses beyond those pages (from the public schema, checked by the tests'
query strings only; no key was available to introspect live): `team.activeCycle { id number
name startsAt endsAt }`, `issue.cycle { number startsAt endsAt }`, `IssueFilter.cycle.isActive`,
`team.triageEnabled`, `issue.children`, `issue.relations`/`inverseRelations`, `issue.comments`,
`issue.attachments`, and mutations `issueUpdate(id, input: { stateId, priority, assigneeId })`
and `commentCreate(input: { issueId, body })`.

What it adds over the CLI: the current cycle with its number and dates, and one round trip per
view instead of a process per call. What it costs: the user makes and pastes a key per
workspace, kept in `orca.secrets`.

## 4. Orca host facts that shape the design

- Panels have no network; all Linear calls and avatar fetches happen in the worker, and images
  reach the panel as size-capped `data:` URLs.
- A worker with a status bar item runs while the plugin is enabled, so it can poll.
- `workspace.readContext` gives the focused workspace's `branch`; `workspace.changed` reports
  changes to a panel without `contributes.events`.
- `workspace.list` (`workspace:read`) gives every workspace with its `branch` and `path`;
  `workspace.open` (`workspace:write`) shows one. There is no host method to create a worktree,
  but the CLI has `orca worktree create --linear-issue <key>`, which infers the repo when run
  from inside a worktree's folder.
- `shell.openExternal` only from the panel, after a press.
