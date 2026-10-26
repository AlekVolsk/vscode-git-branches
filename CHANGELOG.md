# Changelog

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
