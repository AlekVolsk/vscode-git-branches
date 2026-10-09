# Development

## Layout

- `out/extension.js` — activation: waits for the built-in Git extension, registers the view, the decoration provider and the commands.
- `out/branchCommands.js` — branch operations: checkout and double click, new branch, push, pull, rename, local and remote deletion, fetch.
- `out/skillLauncher.js` — Run Skill: the prompt list, and opening a Claude Code session with the chosen prompt.
- `out/skillPrompts.js` — `SKILL.md` frontmatter parsing and placeholder substitution. No `vscode` import.
- `out/branchTreeProvider.js` — the Branches tree: repository, Local and remote nodes, refresh scheduling and tooltips.
- `out/repositoryModel.js` — the branches of one repository, read with a single `git for-each-ref`, and its resolved base branch.
- `out/branchAgeService.js` — branch age and fork point, computed on demand, cached and rate-limited.
- `out/branchDecorationProvider.js` — label colors.
- `out/branchRefs.js` — parsing of git output and text formatting. No `vscode` import, so it runs under plain Node.
- `out/gitCli.js` — the only place that runs the git binary.
- `tools/render-icon.js` — draws `images/icon.png` with plain Node, no dependencies; the geometry lives in the script. vsce refuses an SVG extension icon, so the PNG is generated and committed: `node tools/render-icon.js`.
- `images/view-icon.svg` — view icon, used when the view is moved out of Source Control; views accept SVG.

No build step: the sources in `out/` are what ships.

## Build and install

```bash
npm run build
code --install-extension git-branches.vsix --force
```

`--force` is needed while the version stays the same. Reload the window afterwards.

## Invariants — do not break these

- **Our own git calls run through `execGit` only**: `execFile` with an argument array, never a shell. Branch names come from remotes and other people, so they never reach a command line as text, and commits are passed by sha wherever the sha is known.
- **Every git call runs with `LC_ALL=C`.** `%(upstream:track)` is translated, and the ahead/behind parser reads the untranslated form.
- **The Git extension API supplies repositories, their remotes, `HEAD` and change events; refs are read by the CLI.** One `for-each-ref` per repository returns upstream, tracking, worktree and last commit for every branch, which the API cannot do in one call.
- **Operations go through the Git extension API**: checkout, branch creation and deletion, push, pull, fetch. That keeps its credential prompts and its state updates. The CLI is used only where the API has no call: `branch -m` for a branch that is not `HEAD`, and `check-ref-format`.
- **Refspecs are always full** — `refs/heads/a:refs/heads/b`, `:refs/heads/a`. A short name can also match a tag.
- **Pull of a branch that is not checked out only fast-forwards.** It is `fetch <remote> refs/heads/<upstream>:refs/heads/<branch>` without `+`; a diverged branch is reported and left as it is.
- **The main branch is never deleted.** It is resolved by name from `origin/HEAD`, another remote's `HEAD`, `master`, `main`, independently of `gitBranches.baseBranch`, and matches locally and on every remote. Its tree items carry a `.main` context suffix that hides both delete commands; the commands also drop it from a multi-selection, and Rename does not offer the remote step for it, because that step deletes the old name on the remote.
- **Local and remote deletion never share a command or a confirmation.** Each command takes the branches of its own kind out of a multi-selection and reports how many of the other kind it skipped. Remote deletion is `push <remote> :refs/heads/<branch>`.
- **A typed branch name is checked with `git check-ref-format --branch` and must come back unchanged** — the command expands `@{-1}` into another branch's name.
- **Double click is two opens of the same branch within 500 ms.** A tree view has no double-click event; the item command runs on every open. With `workbench.list.openMode` set to `doubleClick`, every open already is one.
- **Claude Code is reached through `claude-vscode.editor.open(undefined, prompt)`**, which Claude Code uses internally and does not document. With no session id it opens a new session where Claude Code is set to open and puts the prompt into the input without sending it. The call lives in `SkillLauncher#openClaudeSession` only; when it fails, the prompt goes to the clipboard.
- **Branch age is the author date of the oldest commit in `base..branch`.** Git does not store a creation time; this value survives merging the base into the branch and rebasing. A local branch without own commits falls back to the `branch: Created from` entry of its reflog, which exists only on the machine that created the branch and expires with `gc.reflogExpire`. A branch whose tip is already in the base is merged (the `git branch --merged` test) and still gets an age: the author date of the first commit of its own first-parent line, found by walking `log --first-parent` of the branch, at most 1000 commits, to the first commit on the base's first-parent line (`rev-list --first-parent <base>`, cached per base sha). Without such a line it falls back to the reflog creation entry, then to the tip's author date. A branch pointing exactly at the base tip is not merged, so a freshly created branch is not flagged.
- **Age is in calendar units** — hours under a day, days under a month, months and days under a year, then years and months — and comes first in the description, so a long name truncates the upstream rather than the age. Color precedence: current, then merged, then stale (older than six calendar months), then local or remote.
- **Base resolution order**: `gitBranches.baseBranch`, the `HEAD` of `origin`, the `HEAD` of any other remote, `master`, `main`. Branches with the same name as the base (`master`, `origin/master`, `upstream/master`) get no age.
- **Ages are computed only for branches that are rendered**, with at most four git processes at a time, and cached by repository, base sha, ref and branch sha. The fork point is computed on hover, in `resolveTreeItem`.
- **Refresh is cheap or skipped.** The Git extension fires a state change after every status run, which includes file saves. A refresh is debounced, deferred while the view is hidden, and redraws the tree only when the `for-each-ref` output, the remotes, `HEAD` or the settings differ from the previous read.
- **Tree nodes are stable objects per id.** The extension host matches elements by identity, so a redraw of one branch after its age resolves has to fire the same object that `getChildren` returned.
- **Label colors go through a `FileDecorationProvider` on `git-branches:` URIs.** A tree item has no color property of its own. The current branch is bold through a highlight over the whole label, and the highlight has its own theme color, `list.highlightForeground`.
- **Remote URLs are never shown.** They can carry access tokens.
