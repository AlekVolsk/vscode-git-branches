# Changelog

## 1.3.0 — 2026-11-16

### Added

- **Copy branch list** on Local and remote groups: copies visible branch names, one per line, without remote prefixes. Both text and status filters are respected.
- **Status filtering** from the filter row context menu: In progress, New, Merged, Stale and History warnings. One status can be combined with the text search; selecting it again removes the status condition. The row displays both active conditions.
- **Independent filter clearing**: Clear text filter and Clear status filter appear for their active conditions; Clear all filters appears when both are active. The inline × resets both conditions, including an open text input.
- **Group statistics** in Local and remote tooltips: branch count, in progress, new, merged, stale, history warnings and pending calculations. Filtered totals are marked `(filtered)`. Staleness is counted independently of other statuses, so category totals can exceed the branch count. The repository tooltip shows only its path.
- **`gitBranches.staleAfterDays`**: a positive integer threshold in 24-hour days, defaulting to 180. Changes apply immediately.
- **History warnings** for unknown branch ages and branch points predating the default branch history, with an explanation in the tooltip. Pending calculations are not warnings.

### Changed

- **Branch age and fork point** use the estimated first-parent branch point and its committer date. Incoming merges from the base do not move the original first-parent intersection forward. For unrelated histories, incoming merge parents provide a heuristic fallback; an unrecoverable branch point remains unknown.
- **The default branch** is identified independently of the comparison base. Its age uses the oldest commit on its first-parent history, with the history start date shown in the tooltip. Both local and remote entries use the local-branch color and are exempt from staleness.
- **Branch statuses** distinguish `same as base`, `no own commits`, `up to date with base` and `merged`. Equal tips count as new without an unknown-age warning. Fast-forward ambiguity is not presented as proof of a merge.
- **Branch colors**: new branches use teal (`#448C83` in dark themes, `#337069` in light themes), merged branches use yellow, and history warnings use coral red with priority over other colors. The new `gitBranches.newBranchForeground` and `gitBranches.invalidBranchForeground` tokens join the existing palette under `workbench.colorCustomizations`; all tokens are documented in the README.
- **The active local branch and its tracked remote** share the current-branch color, unless a history warning takes priority.

### Fixed

- Active branch labels no longer use a full-name highlight that can introduce a background color.
- Fetch actions explicitly refresh the branch tree after completion instead of relying only on Git extension events.

## 1.2.1 — 2026-10-26

- License changed from MIT to BSD 3-Clause.
- The README states that the extension is developed and maintained with the help of AI tools.
- The sources are type-checked in strict mode; no change in behaviour.

## 1.2.0 — 2026-10-23

### Added

- Branch filter: the first row of the tree filters branches by name; every word must match as a case-insensitive substring, matches are highlighted, repositories and groups without matches are hidden, the others are expanded.
- The filter row shows how many branches match, and each group shows its matches and its total while a filter is on; the × on the row clears the filter, closing the input keeps it.
- **Delete local and remote branch**: deletes a local branch together with its upstream, or a remote branch together with the local branches that track it, after one confirmation that also lists the branches with commits not in the base.
- In **Delete local and remote branch** the local branch is deleted first; if it is not fully merged and **Force delete** is declined, its remote branch is kept too. Pairs with the main branch or a checked-out local branch are skipped.
- **Copy name to clipboard** in the branch context menu: the name without the remote prefix; with several branches selected, one name per line.

### Changed

- Command, button and dialog titles use sentence case (**Fetch all**, **New branch from…**, **Run skill…**, **Delete local branch**, **Force delete**, **Show log** and others).

## 1.0.0 — 2026-10-09

First release.

- **Branches** section in the Source Control panel with the local and remote branches of every open repository; a node per repository when several are open, a **Local** group and a group per remote.
- Upstream and ahead/behind counts for local branches; distinct colors for the checked-out, local and remote branches; worktree icon for branches checked out in another worktree.
- Branch age shown first in the label; branches merged into the base are marked `merged`, other branches older than six months are gray; the tooltip shows the last commit, base branch, fork point and age source.
- Checkout on double click; a remote branch is checked out as a local branch that tracks it.
- **Push** and **Pull** on local branches; publishing with `-u` for a branch without an upstream; fast-forward-only pull for a branch that is not checked out.
- **Fetch All** and **Fetch and Prune** in the section title and on repository nodes.
- **Checkout**, **New Branch From…**, **Rename…** (optionally on the remote too) and **Run Skill…** in the context menu.
- **Delete Local Branch** and **Delete Remote Branch** as separate commands with separate confirmations, multi-selection support and extra confirmation for protected branches; the main branch is never deleted.
- **Run Skill…** opens a new Claude Code session with a prompt about the branch from `gitBranches.skills`, repository or user skills, or typed by hand.
- Settings `gitBranches.baseBranch` and `gitBranches.skills`; sorting follows `git.branchSortOrder`; all colors can be overridden in `workbench.colorCustomizations`.
