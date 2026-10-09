# Git Branches

A **Branches** section in the Source Control panel with the local and remote branches of every open repository, and the everyday branch operations on them.

- One node per repository when several are open; inside it the **Local** group and a group per remote.
- Local branches show their upstream and how far they are ahead of and behind it.
- The checked-out branch is bold and has its own color; local and remote branches are colored differently. A branch checked out in another worktree is marked with the worktree icon.
- Every branch shows its age first, so it survives a narrow panel. A branch already merged into the base is marked `merged` and is burgundy; other branches older than six months are gray. The tooltip adds the last commit, the base branch, the fork point and where the age comes from.

## Installation

```bash
code --install-extension git-branches.vsix
```

Or in VS Code: **Extensions** panel → `...` menu → **Install from VSIX…**. After installing, reload the window (**Developer: Reload Window**).

## Actions

- **Double click** checks a branch out. A remote branch becomes a local branch that tracks it.
- **Push** and **Pull** are on every local branch, as hover buttons and in the context menu. A branch without an upstream is published with `-u`. Pull on a branch that is not checked out only fast-forwards it.
- **Fetch All** and **Fetch and Prune** are in the section title and on every repository node. Fetch All prunes too when `git.pruneOnFetch` is on.
- **Checkout**, **New Branch From…**, **Rename…** and **Run Skill…** are in the context menu.
- **Rename…** can rename the branch on its remote too: it pushes the new name, makes it the upstream and deletes the old name. These are three separate steps; if one fails, the message says which state the remote is left in.
- **Delete Local Branch** and **Delete Remote Branch** are separate commands with separate confirmations. Both work on a multi-selection and skip the branches of the other kind. The checked-out branch and branches checked out in other worktrees are not deleted; protected branches (the base branch, matches of `git.branchProtection`) only after one more confirmation.
- **The main branch is never deleted**, neither locally nor on a remote, and is renamed only locally. It is the default branch of the remote — the target of `origin/HEAD`, then of another remote's `HEAD`, then `master`, then `main` — by name, so `master`, `origin/master` and `upstream/master` are all covered.

## Run Skill

Opens a new Claude Code session with a prompt about the branch in its input; nothing is sent until you press Enter. The list offers the prompts from `gitBranches.skills`, the skills found in `<repository>/.claude/skills` and `~/.claude/skills`, and a prompt typed by hand.

The session is opened through a command that Claude Code uses internally, so an update of Claude Code can break it. When it fails, the prompt is copied to the clipboard.

## Settings

- `gitBranches.baseBranch` — the branch that ages and fork points are measured against, e.g. `origin/master`. Empty means the `HEAD` of `origin`, then of any other remote, then `master`, then `main`.
- `gitBranches.skills` — prompts for Run Skill, e.g. `[{ "label": "Review", "prompt": "/code-review ${branch}" }]`. Substituted: `${branch}`, `${ref}`, `${remote}`, `${upstream}`, `${base}`, `${repoPath}`, `${repoName}`. A new Claude Code session starts in the workspace folder, so with several repositories open a prompt needs `${repoPath}` to point at the right one.
- `git.branchSortOrder` — the built-in Git setting; branches are sorted alphabetically or by committer date.

## Branch age

Git does not record when a branch was created, so the age is derived. It counts from the oldest commit of the branch that is not in the base branch, by author date, so merging the base into the branch does not reset it. A branch whose tip is already in the base is merged — the same test as `git branch --merged` — and still gets an age, because a merged branch that has been hanging around for months is worth seeing: it counts from the first commit of the branch's own first-parent line, the part that is not on the base's first-parent line. A branch without such a line (fast-forwarded into the base, or reset onto one of its commits) counts from the creation entry in its reflog, if it is local and has one, otherwise from its last commit. A branch that points at the tip of the base has no commits yet and is not marked merged; it only gets an age from the reflog.

The age is shown in hours under a day, in days under a month, in months and days under a year (`9mo 24d`), then in years and months (`1y 6mo`). Months are calendar months.

## Colors

All colors can be overridden in `workbench.colorCustomizations`:

- `gitBranches.localBranchForeground`
- `gitBranches.remoteBranchForeground`
- `gitBranches.currentBranchForeground`
- `gitBranches.mergedBranchForeground` — branches already merged into the base
- `gitBranches.staleBranchForeground` — other branches older than six months

The checked-out branch keeps its own color in any case.

## License

MIT.
