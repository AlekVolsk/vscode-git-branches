# Git Branches

A **Branches** section in the Source Control panel with local and remote branches from every open repository and everyday branch operations.

- A filter row combines branch-name search with a branch status.
- Each repository contains a **Local** group and a group per remote. Multiple repositories have separate root nodes.
- Local branches show their upstream and ahead/behind counts. Branches checked out in another worktree have a worktree icon.
- Branch rows show age first, followed by status and tracking details. Tooltips explain the last commit, estimated branch point, age and history warnings.
- The active local branch and its tracked remote share a color. Local, remote, new, merged, stale and anomalous branches have distinct colors.

> This extension was created and is maintained with the help of AI tools.

## Installation

```bash
code --install-extension git-branches.vsix
```

Alternatively, use **Extensions → … → Install from VSIX…**. Run **Developer: Reload Window** after installation.

## Actions

- **Double click** checks out a branch. A remote branch becomes a local branch tracking it.
- **Push** and **Pull** are available as local-branch hover buttons and context menu actions. Push publishes a branch without an upstream using `-u`. Pull on a branch that is not checked out only fast-forwards it.
- **Fetch all** and **Fetch and prune** are available in the view title and on repository nodes. Fetch all also prunes when VS Code’s `git.pruneOnFetch` is enabled. Both actions refresh the tree after completion.
- **Checkout**, **New branch from…**, **Rename…**, **Run skill…** and **Copy name to clipboard** are available in branch context menus. Copy name supports multiple selected branches and omits remote prefixes.
- **Rename…** can also rename the remote branch: it pushes the new name, sets the upstream and deletes the old remote name.
- **Delete local branch**, **Delete remote branch** and **Delete local and remote branch** support multiple selection and require confirmation. Local branches checked out here or in another worktree cannot be deleted. Unmerged local branches require an additional force-delete confirmation.
- **Delete local and remote branch** pairs branches by upstream tracking, never just by name. The local branch is deleted first; declining force deletion preserves its remote counterpart. The default branch and pairs containing a checked-out local branch are skipped.
- **Copy branch list**, the standard copy hover icon on Local and remote groups, copies visible branch names, one per line, without remote prefixes. Without filters it copies the entire group.

The default branch cannot be deleted or renamed on the remote; a local rename is allowed.

## Filtering

Click the first row to search by branch name. Matching is case-insensitive; all space-separated words must occur in the name. Closing the input preserves the search.

Right-click the filter row to select **In progress**, **New**, **Merged**, **Stale** or **History warnings**. One status is active at a time and combines with the text search. Selecting the active status again removes that condition. The row shows both conditions, for example `LossLog · Merged`, and the match count. Branches with pending status calculations appear in status-filtered results once their matching status is resolved.

Clear actions depend on the active conditions:

- **Clear text filter** appears when text is active and preserves the status filter.
- **Clear status filter** appears when a status is active and preserves the text search.
- **Clear all filters** appears when both are active.
- The inline **×** clears both conditions, including text in an open input.

Filtered groups expand automatically; groups and repositories without matches are hidden.

## Branch age and default branch

Age is an estimate from commit history, not the creation time of the Git branch reference. The extension follows the branch’s first-parent history to the first shared commit with the base’s first-parent history. **Fork point** and **Age** use that commit and its committer date. Incoming merges from the base do not move the original intersection forward while it remains available.

The branch-point commit may predate actual branch creation. A branch created on November 1 from an October 29 commit is dated October 29.

For unrelated histories, the extension searches incoming merge parents, starting with the most recent merge, for a shared first-parent commit. This fallback is heuristic: merge parents do not record source branch names, and merges from other working branches or repeated merges can produce a different estimate. An unrecoverable point remains unknown; neither the repository root nor the branch tip substitutes for it. Equal branch and base tips have no separately identifiable branch point, but are not treated as a history warning solely for that reason.

The default branch is identified by `origin/HEAD`, then another remote’s `HEAD`, then `master`, then `main`, independently of the configured comparison base. Its age uses the oldest commit on its own first-parent history, with the start date shown in the tooltip. Local and remote default-branch entries use the local-branch color unless active, and are never marked stale or compared against themselves for history warnings.

Age is displayed in calendar units: hours below a day, days below a month, months and days below a year, then years and months. The stale threshold uses elapsed 24-hour days, not calendar months.

## Branch statuses and warnings

- **Same as base**: the branch and base tips are identical. It counts as New without claiming that a merge occurred.
- **No own commits**: the branch has no commits outside the base and its tip lies on the base’s first-parent line. It counts as New. The graph alone cannot distinguish an unused branch from some fast-forwarded branches.
- **Up to date with base**: the branch contains the base and additional commits. It is a working branch, not a merged branch.
- **Merged**: the tip is reachable from the base but lies outside its first-parent line. Squash merges cannot be reliably identified by ancestry.
- **Stale**: a non-default branch with a known age at or beyond `gitBranches.staleAfterDays`.
- **History warnings**: the branch point is unknown after calculation, except for equal tips, or predates the start of the default branch history. The tooltip explains the anomaly. Replaced repository history can legitimately produce this warning on older branches. Pending calculations are not warnings.

Warning colors take priority over all other colors. Otherwise, the active branch and its tracked remote take priority, followed by the default branch, New, Merged and Stale. Remaining entries use their local or remote color.

## Group statistics

Local and remote group tooltips show visible branch totals: **In progress**, **New**, **Merged**, **Stale**, **History warnings** and, while necessary, **Calculating**. The stale label uses the configured day threshold. The default branch counts as In progress; active working branches are classified by status rather than highlight color.

Staleness is counted independently of other categories. A red history-warning branch can also be stale, so category totals may exceed the branch count. Unknown ages do not count as stale. The Stale filter follows the same independent rule.

Both filter conditions apply to statistics; filtered totals are marked `(filtered)`. Each Local or remote group is counted independently, and the repository tooltip shows only its path. Statistics update as age calculations complete.

## Settings

- **`gitBranches.baseBranch`** — comparison base name, such as `master` or `origin/main`. Empty selects `origin/HEAD`, another remote’s HEAD, then local or remote `master` or `main`. This does not change default-branch protection.
- **`gitBranches.staleAfterDays`** — positive integer threshold in 24-hour days, default `180`. Changes apply immediately; the default branch is exempt.
- **`gitBranches.skills`** — prompts available through Run skill. Each entry has `name`, `description` and `prompt`. A prompt may also be an absolute path to a `SKILL.md` file.

The extension follows VS Code’s `git.branchSortOrder`: `alphabetically` by default, or `committerdate` for recent commits first. Local and remote references are read from the local repository; use Fetch and prune to remove remote-tracking references deleted on the server.

### Run skill

Run skill opens a Claude Code session in the selected repository with the chosen prompt. The Anthropic Claude Code extension must be installed and enabled.

For a `SKILL.md` path, `name` and `description` come from its frontmatter, while `prompt` and `arguments` are substituted into the body; the resulting body becomes the command input. Missing frontmatter uses the configured fallback name and description.

Supported placeholders are `{branch}`, `{baseBranch}`, `{repository}`, `{repositoryPath}` and `{remote}`. The base name has no `refs/heads/`, `refs/remotes/` or remote prefix. The default prompts are **Review** and **Compare with base**.

## Colors

All colors are VS Code theme tokens, configured together in `workbench.colorCustomizations`, including per-theme overrides. No separate extension color settings are required.

| Token | Purpose | Default |
| --- | --- | --- |
| `gitBranches.localBranchForeground` | Local and default branches | `charts.blue` |
| `gitBranches.remoteBranchForeground` | Remote branches | `charts.purple` |
| `gitBranches.currentBranchForeground` | Active local branch and its tracked remote | `charts.green` |
| `gitBranches.newBranchForeground` | New branches | Dark: `#448C83`; light: `#337069` |
| `gitBranches.mergedBranchForeground` | Merged branches | Dark: `#E5C07B`; light: `#8A6500` |
| `gitBranches.staleBranchForeground` | Stale branches | Theme-specific gray |
| `gitBranches.invalidBranchForeground` | History warnings | Dark: `#D0607A`; light: `#8E1B3B` |

For example, in VS Code settings:

```json
"workbench.colorCustomizations": {
    "gitBranches.localBranchForeground": "#3794FF",
    "gitBranches.remoteBranchForeground": "#B180D7",
    "gitBranches.currentBranchForeground": "#89D185",
    "gitBranches.newBranchForeground": "#448C83",
    "gitBranches.mergedBranchForeground": "#E5C07B",
    "gitBranches.staleBranchForeground": "#808080",
    "gitBranches.invalidBranchForeground": "#D0607A"
}
```

## License

[BSD 3-Clause](LICENSE.txt).
