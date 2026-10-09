'use strict';

const vscode = require('vscode');
const { describeGitError, execGit } = require('./gitCli');
const { displayNameOf } = require('./branchRefs');

const DOUBLE_CLICK_MS = 500;
const LISTED_BRANCHES_LIMIT = 10;
const PRIMARY_REMOTE = 'origin';
const BRANCH_NOT_FULLY_MERGED = 'BranchNotFullyMerged';

/**
 * Branch operations. Network ones go through the Git extension API, so its credential prompts and
 * progress apply; renaming goes through the CLI, which the API cannot do for a branch that is not HEAD.
 */
class BranchCommands {
    #tree;
    #skills;
    #log;
    #viewId;
    #gitPath;
    #lastOpen = { nodeId: undefined, at: 0 };

    constructor({ tree, skills, log, viewId, gitPath }) {
        this.#tree = tree;
        this.#skills = skills;
        this.#log = log;
        this.#viewId = viewId;
        this.#gitPath = gitPath;
    }

    register() {
        const handlers = {
            'gitBranches.openBranch': (node) => this.#openBranch(node),
            'gitBranches.checkout': (node) => this.#checkout(node),
            'gitBranches.createBranchFrom': (node) => this.#createBranchFrom(node),
            'gitBranches.push': (node) => this.#push(node),
            'gitBranches.pull': (node) => this.#pull(node),
            'gitBranches.rename': (node) => this.#rename(node),
            'gitBranches.deleteLocal': (node, selection) => this.#deleteLocal(node, selection),
            'gitBranches.deleteRemote': (node, selection) => this.#deleteRemote(node, selection),
            'gitBranches.runSkill': (node) => this.#skills.run(node.model, node.branch),
            'gitBranches.fetchAll': (node) => this.#fetch(node, false),
            'gitBranches.fetchPrune': (node) => this.#fetch(node, true),
        };
        return Object.entries(handlers).map(([command, handler]) => vscode.commands.registerCommand(
            command,
            async (...args) => {
                try {
                    await handler(...args);
                } catch (error) {
                    const title = error?.operationTitle === undefined ? command : `${error.operationTitle} failed`;
                    this.#reportFailure(title, error);
                }
            },
        ));
    }

    async #openBranch(node) {
        const openMode = vscode.workspace.getConfiguration('workbench.list').get('openMode', 'singleClick');
        const now = Date.now();
        const isDoubleClick = openMode === 'doubleClick'
            || (this.#lastOpen.nodeId === node.id && now - this.#lastOpen.at <= DOUBLE_CLICK_MS);
        this.#lastOpen = isDoubleClick ? { nodeId: undefined, at: 0 } : { nodeId: node.id, at: now };
        if (isDoubleClick) {
            await this.#checkout(node);
        }
    }

    async #checkout(node) {
        const { model, branch } = node;
        if (branch.kind === 'local') {
            if (branch.isInOtherWorktree) {
                vscode.window.showInformationMessage(`${branch.name} is checked out in ${branch.worktreePath}.`);
            } else if (!branch.isHead) {
                await this.#checkoutLocal(model, branch.name);
            }
            return;
        }

        const trackingRef = `${branch.remoteName}/${branch.name}`;
        const existing = model.local.find((local) => local.name === branch.name);
        if (existing !== undefined) {
            if (existing.upstream !== trackingRef) {
                const tracking = existing.upstream === undefined ? 'has no upstream' : `tracks ${existing.upstream}`;
                const answer = await vscode.window.showWarningMessage(
                    `A local branch ${existing.name} already exists and ${tracking}.`,
                    'Checkout Local Branch',
                );
                if (answer === undefined) {
                    return;
                }
            }
            if (!existing.isHead) {
                await this.#checkoutLocal(model, existing.name);
            }
            return;
        }

        await this.#withProgress(model, `Checkout ${trackingRef}`, async () => {
            await model.repository.createBranch(branch.name, true, branch.refname);
            await model.repository.setBranchUpstream(branch.name, trackingRef);
        });
    }

    #checkoutLocal(model, name) {
        return this.#withProgress(model, `Checkout ${name}`, () => model.repository.checkout(name));
    }

    async #createBranchFrom(node) {
        const { model, branch } = node;
        const name = await this.#askBranchName(model, `New branch from ${displayNameOf(branch)}`, '');
        if (name === undefined) {
            return;
        }
        await this.#withProgress(model, `Create ${name}`, () => model.repository.createBranch(name, true, branch.sha));
    }

    async #push(node) {
        const { model, branch } = node;
        if (branch.upstreamRemote !== undefined) {
            const refspec = `refs/heads/${branch.name}:refs/heads/${branch.upstreamBranch}`;
            await this.#withProgress(
                model,
                `Push ${branch.name} to ${branch.upstreamRemote}/${branch.upstreamBranch}`,
                () => model.repository.push(branch.upstreamRemote, refspec, false),
            );
            return;
        }
        const remote = await this.#pickRemote(model, `Publish ${branch.name} to`);
        if (remote === undefined) {
            return;
        }
        const refspec = `refs/heads/${branch.name}:refs/heads/${branch.name}`;
        await this.#withProgress(
            model,
            `Publish ${branch.name} to ${remote}`,
            () => model.repository.push(remote, refspec, true),
        );
    }

    async #pull(node) {
        const { model, branch } = node;
        if (branch.upstreamRemote === undefined) {
            const reason = branch.upstream === undefined
                ? 'has no upstream'
                : `tracks the local branch ${branch.upstream}`;
            vscode.window.showInformationMessage(`${branch.name} ${reason}; there is nothing to pull from.`);
            return;
        }
        if (branch.isHead) {
            await this.#withProgress(model, `Pull ${branch.name}`, () => model.repository.pull());
            return;
        }
        const refspec = `refs/heads/${branch.upstreamBranch}:refs/heads/${branch.name}`;
        try {
            await this.#withProgress(
                model,
                `Update ${branch.name} from ${branch.upstream}`,
                () => model.repository.fetch({ remote: branch.upstreamRemote, ref: refspec }),
            );
        } catch (error) {
            if (!/non-fast-forward/.test(describeGitError(error))) {
                throw error;
            }
            this.#log.error(`Update ${branch.name}: ${describeGitError(error)}`);
            vscode.window.showErrorMessage(
                `${branch.name} has diverged from ${branch.upstream}. A branch that is not checked out `
                + 'can only be fast-forwarded; check it out to merge or rebase.',
            );
        }
    }

    async #rename(node) {
        const { model, branch } = node;
        if (this.#isProtected(model, branch) && !(await this.#confirmProtected([node], 'Rename'))) {
            return;
        }
        const newName = await this.#askBranchName(model, `Rename ${branch.name}`, branch.name, branch.name);
        if (newName === undefined || newName === branch.name) {
            return;
        }

        const isMainBranch = model.isMainBranch(branch);
        let isRemoteToo = false;
        if (!isMainBranch && branch.upstreamRemote !== undefined && !branch.isUpstreamGone) {
            const remoteChoice = `Locally and on ${branch.upstreamRemote}`;
            const answer = await vscode.window.showWarningMessage(`Rename ${branch.name} to ${newName}`, {
                modal: true,
                detail: `Locally only: the upstream stays ${branch.upstream}.\n\n`
                    + `On ${branch.upstreamRemote} too: push ${newName}, make it the upstream, then delete `
                    + `${branch.upstream} for everyone. These are three separate steps; if one fails, `
                    + 'the ones before it are not undone.',
            }, 'Locally Only', remoteChoice);
            if (answer === undefined) {
                return;
            }
            isRemoteToo = answer === remoteChoice;
        }

        try {
            await execGit(this.#gitPath, model.rootPath, ['branch', '-m', branch.name, newName]);
        } catch (error) {
            this.#reportFailure(`Rename of ${branch.name} failed`, error);
            return;
        }
        await this.#tree.refreshRepository(model);
        if (isMainBranch && branch.upstream !== undefined) {
            vscode.window.showInformationMessage(
                `${branch.name} is renamed locally only: ${branch.upstream} is the main branch and is never deleted.`,
            );
        }
        if (!isRemoteToo) {
            return;
        }

        const remote = branch.upstreamRemote;
        try {
            await this.#withProgress(
                model,
                `Push ${newName} to ${remote}`,
                () => model.repository.push(remote, `refs/heads/${newName}:refs/heads/${newName}`, true),
            );
        } catch (error) {
            this.#reportFailure(
                `${branch.name} is renamed to ${newName} locally, but pushing it to ${remote} failed; `
                + `${branch.upstream} is unchanged`,
                error,
            );
            return;
        }
        try {
            await this.#withProgress(
                model,
                `Delete ${branch.upstream}`,
                () => model.repository.push(remote, `:refs/heads/${branch.upstreamBranch}`),
            );
        } catch (error) {
            this.#reportFailure(
                `${newName} is pushed to ${remote}, but deleting ${branch.upstream} failed; `
                + `${remote} has both branches`,
                error,
            );
        }
    }

    async #deleteLocal(node, selection) {
        const selected = selectedBranchNodes(node, selection);
        const locals = selected.filter((candidate) => candidate.branch.kind === 'local');
        const mainBranches = locals.filter((candidate) => candidate.model.isMainBranch(candidate.branch));
        const checkedOut = locals.filter((candidate) => !mainBranches.includes(candidate)
            && (candidate.branch.isHead || candidate.branch.isInOtherWorktree));
        const blocked = [...mainBranches, ...checkedOut];
        const notes = mainBranchNotes(mainBranches);
        if (checkedOut.length > 0) {
            notes.push(`Skipped, checked out: ${checkedOut.map((candidate) => candidate.branch.name).join(', ')}.`);
        }
        if (selected.length > locals.length) {
            const remoteCount = selected.length - locals.length;
            notes.push(`Remote branches skipped: ${remoteCount}. Delete them with Delete Remote Branch.`);
        }

        let targets = locals.filter((candidate) => !blocked.includes(candidate));
        if (targets.length === 0) {
            vscode.window.showInformationMessage(['Nothing to delete.', ...notes].join(' '));
            return;
        }
        targets = await this.#withoutDeclinedProtected(targets, 'Delete Locally');
        if (targets.length === 0) {
            return;
        }

        const confirmation = 'Delete Locally';
        const answer = await vscode.window.showWarningMessage(
            targets.length === 1
                ? `Delete the local branch ${targets[0].branch.name}?`
                : `Delete ${targets.length} local branches?`,
            { modal: true, detail: [listBranches(targets), ...notes].join('\n\n') },
            confirmation,
        );
        if (answer !== confirmation) {
            return;
        }

        const unmerged = [];
        const failures = [];
        for (const target of targets) {
            try {
                await target.model.repository.deleteBranch(target.branch.name, false);
            } catch (error) {
                if (isNotFullyMerged(error)) {
                    unmerged.push(target);
                } else {
                    failures.push({ target, error });
                }
            }
        }

        if (unmerged.length > 0) {
            const force = 'Force Delete';
            const forceAnswer = await vscode.window.showWarningMessage(
                unmerged.length === 1
                    ? `${unmerged[0].branch.name} is not fully merged. Delete it anyway?`
                    : `${unmerged.length} branches are not fully merged. Delete them anyway?`,
                {
                    modal: true,
                    detail: `${listBranches(unmerged)}\n\n`
                        + 'Their unmerged commits stay reachable only through the reflog.',
                },
                force,
            );
            if (forceAnswer === force) {
                for (const target of unmerged) {
                    try {
                        await target.model.repository.deleteBranch(target.branch.name, true);
                    } catch (error) {
                        failures.push({ target, error });
                    }
                }
            }
        }

        await this.#refreshTouched(targets);
        this.#reportBatchFailures('Could not delete locally', failures);
    }

    async #deleteRemote(node, selection) {
        const selected = selectedBranchNodes(node, selection);
        const remoteBranches = selected.filter((candidate) => candidate.branch.kind === 'remote');
        const mainBranches = remoteBranches.filter((candidate) => candidate.model.isMainBranch(candidate.branch));
        let targets = remoteBranches.filter((candidate) => !mainBranches.includes(candidate));
        const notes = mainBranchNotes(mainBranches);
        if (selected.length > remoteBranches.length) {
            const localCount = selected.length - remoteBranches.length;
            notes.push(`Local branches skipped: ${localCount}. Delete them with Delete Local Branch.`);
        }
        if (targets.length === 0) {
            vscode.window.showInformationMessage(['Nothing to delete.', ...notes].join(' '));
            return;
        }
        targets = await this.#withoutDeclinedProtected(targets, 'Delete on Remote');
        if (targets.length === 0) {
            return;
        }

        const remotes = [...new Set(targets.map((target) => target.branch.remoteName))].join(', ');
        const confirmation = 'Delete on Remote';
        const answer = await vscode.window.showWarningMessage(
            targets.length === 1
                ? `Delete ${displayNameOf(targets[0].branch)} on ${remotes}?`
                : `Delete ${targets.length} branches on ${remotes}?`,
            {
                modal: true,
                detail: [
                    'This removes the branches from the server for everyone and cannot be undone from here.',
                    listBranches(targets),
                    ...notes,
                ].join('\n\n'),
            },
            confirmation,
        );
        if (answer !== confirmation) {
            return;
        }

        const failures = [];
        for (const target of targets) {
            const { model, branch } = target;
            try {
                await this.#withProgress(
                    model,
                    `Delete ${displayNameOf(branch)}`,
                    () => model.repository.push(branch.remoteName, `:refs/heads/${branch.name}`),
                );
            } catch (error) {
                failures.push({ target, error });
            }
        }
        await this.#refreshTouched(targets);
        this.#reportBatchFailures('Could not delete on the remote', failures);
    }

    async #fetch(node, isPruning) {
        const models = node?.type === 'repository' ? [node.model] : this.#tree.models;
        const failures = [];
        for (const model of models) {
            try {
                await this.#withProgress(
                    model,
                    `${isPruning ? 'Fetch and prune' : 'Fetch'} ${model.name}`,
                    () => model.repository.fetch(isPruning ? { all: true, prune: true } : { all: true }),
                );
            } catch (error) {
                failures.push({ model, error });
            }
        }
        for (const { model, error } of failures) {
            this.#reportFailure(`Fetch of ${model.name} failed`, error);
        }
    }

    async #withoutDeclinedProtected(targets, action) {
        const protectedTargets = targets.filter((target) => this.#isProtected(target.model, target.branch));
        if (protectedTargets.length === 0 || (await this.#confirmProtected(protectedTargets, action))) {
            return targets;
        }
        return targets.filter((target) => !protectedTargets.includes(target));
    }

    async #confirmProtected(nodes, action) {
        const confirmation = `${action} Anyway`;
        const answer = await vscode.window.showWarningMessage(
            nodes.length === 1
                ? `${displayNameOf(nodes[0].branch)} is protected.`
                : `${nodes.length} branches are protected.`,
            {
                modal: true,
                detail: `${listBranches(nodes)}\n\n`
                    + 'Protected means the main branch, the base branch or a match of git.branchProtection.',
            },
            confirmation,
        );
        return answer === confirmation;
    }

    #isProtected(model, branch) {
        if (model.isMainBranch(branch) || model.isBaseLike(branch)) {
            return true;
        }
        if (typeof model.repository.isBranchProtected !== 'function') {
            return false;
        }
        const remote = branch.kind === 'remote' ? branch.remoteName : branch.upstreamRemote;
        const upstreamName = branch.kind === 'remote' ? branch.name : branch.upstreamBranch;
        return model.repository.isBranchProtected({
            name: branch.name,
            upstream: remote === undefined ? undefined : { remote, name: upstreamName },
        });
    }

    async #pickRemote(model, title) {
        const remotes = model.repository.state.remotes.map((remote) => remote.name);
        if (remotes.length === 0) {
            vscode.window.showErrorMessage(`${model.name} has no remotes.`);
            return undefined;
        }
        if (remotes.length === 1) {
            return remotes[0];
        }
        const ordered = [
            ...remotes.filter((remote) => remote === PRIMARY_REMOTE),
            ...remotes.filter((remote) => remote !== PRIMARY_REMOTE),
        ];
        return vscode.window.showQuickPick(ordered, { title });
    }

    #askBranchName(model, title, value, currentName) {
        return vscode.window.showInputBox({
            title,
            value,
            prompt: 'Branch name',
            validateInput: (name) => this.#branchNameProblem(model, name, currentName),
        });
    }

    async #branchNameProblem(model, name, currentName) {
        if (name === '' || name === currentName) {
            return name === '' ? 'Enter a branch name.' : undefined;
        }
        if (name.startsWith('-')) {
            return 'A branch name cannot start with "-".';
        }
        if (model.local.some((branch) => branch.name === name)) {
            return `A local branch ${name} already exists.`;
        }
        try {
            const normalized = await execGit(this.#gitPath, model.rootPath, ['check-ref-format', '--branch', name]);
            return normalized.trim() === name ? undefined : 'Not a valid branch name.';
        } catch {
            return 'Not a valid branch name.';
        }
    }

    #withProgress(model, title, task) {
        return vscode.window.withProgress({ location: { viewId: this.#viewId }, title }, async () => {
            this.#log.info(`${title} (${model.rootPath})`);
            try {
                await task();
            } catch (error) {
                if (error !== null && typeof error === 'object') {
                    error.operationTitle ??= title;
                }
                throw error;
            }
        });
    }

    async #refreshTouched(nodes) {
        for (const model of new Set(nodes.map((node) => node.model))) {
            await this.#tree.refreshRepository(model);
        }
    }

    #reportBatchFailures(title, failures) {
        if (failures.length === 0) {
            return;
        }
        for (const { target, error } of failures) {
            const where = `${displayNameOf(target.branch)} in ${target.model.rootPath}`;
            this.#log.error(`${title} ${where}: ${describeGitError(error)}`);
        }
        const names = failures.map(({ target }) => displayNameOf(target.branch)).join(', ');
        const firstReason = describeGitError(failures[0].error);
        vscode.window.showErrorMessage(`${title}: ${names}. ${firstReason}`, 'Show Log').then((answer) => {
            if (answer === 'Show Log') {
                this.#log.show();
            }
        });
    }

    #reportFailure(title, error) {
        const reason = describeGitError(error);
        this.#log.error(`${title}: ${reason}`);
        vscode.window.showErrorMessage(`${title}: ${reason}`);
    }
}

function selectedBranchNodes(node, selection) {
    const nodes = Array.isArray(selection) && selection.includes(node) ? selection : [node];
    return nodes.filter((candidate) => candidate?.type === 'branch');
}

function mainBranchNotes(mainBranches) {
    if (mainBranches.length === 0) {
        return [];
    }
    const names = mainBranches.map((candidate) => displayNameOf(candidate.branch)).join(', ');
    return [`Not deleted, the main branch is never deleted: ${names}.`];
}

function isNotFullyMerged(error) {
    return error?.gitErrorCode === BRANCH_NOT_FULLY_MERGED || /not fully merged/.test(describeGitError(error));
}

function listBranches(nodes) {
    const isSeveralRepositories = new Set(nodes.map((node) => node.model)).size > 1;
    const lines = nodes.slice(0, LISTED_BRANCHES_LIMIT).map((node) => {
        const name = displayNameOf(node.branch);
        return isSeveralRepositories ? `${node.model.name}: ${name}` : name;
    });
    if (nodes.length > LISTED_BRANCHES_LIMIT) {
        lines.push(`… and ${nodes.length - LISTED_BRANCHES_LIMIT} more`);
    }
    return lines.join('\n');
}

module.exports = { BranchCommands };
