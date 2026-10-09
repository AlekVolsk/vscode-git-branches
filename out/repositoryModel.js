'use strict';

const path = require('path');
const vscode = require('vscode');
const { execGit } = require('./gitCli');
const {
    FOR_EACH_REF_FORMAT,
    parseForEachRef,
    resolveBaseBranch,
    resolveMainBranchName,
    shortSha,
    sortBranches,
} = require('./branchRefs');

class RepositoryModel {
    repository;
    rootPath;
    name;
    local = [];
    remotes = new Map();
    base = undefined;
    configuredBase = '';
    mainBranchName = undefined;
    #gitPath;
    #signature = '';

    constructor(repository, gitPath) {
        this.repository = repository;
        this.rootPath = repository.rootUri.fsPath;
        this.name = path.basename(this.rootPath);
        this.#gitPath = gitPath;
    }

    get headDescription() {
        const head = this.repository.state.HEAD;
        if (head === undefined) {
            return '';
        }
        if (head.name !== undefined) {
            return head.name;
        }
        return head.commit === undefined ? '' : `detached at ${shortSha(head.commit)}`;
    }

    get branches() {
        return [...this.local, ...[...this.remotes.values()].flat()];
    }

    isBaseLike(branch) {
        return this.base !== undefined && branch.name === this.base.name;
    }

    /**
     * The main branch is the default branch of the remote, by name, locally and on every remote.
     */
    isMainBranch(branch) {
        return this.mainBranchName !== undefined && branch.name === this.mainBranchName;
    }

    invalidate() {
        this.#signature = '';
    }

    async refresh() {
        const rootUri = this.repository.rootUri;
        const remoteNames = this.repository.state.remotes.map((remote) => remote.name);
        const configuredBase = vscode.workspace.getConfiguration('gitBranches', rootUri).get('baseBranch', '').trim();
        const sortOrder = vscode.workspace.getConfiguration('git', rootUri).get('branchSortOrder', 'alphabetically');
        const output = await execGit(this.#gitPath, this.rootPath, [
            'for-each-ref',
            `--format=${FOR_EACH_REF_FORMAT}`,
            'refs/heads',
            'refs/remotes',
        ]);

        const signature = [output, remoteNames.join('\n'), configuredBase, sortOrder, this.headDescription].join('\0');
        if (signature === this.#signature) {
            return false;
        }
        this.#signature = signature;

        const refs = parseForEachRef(output, remoteNames);
        this.local = sortBranches(refs.local, sortOrder);
        this.remotes = new Map();
        for (const [remoteName, branches] of refs.remotes) {
            this.remotes.set(remoteName, sortBranches(branches, sortOrder));
        }
        this.configuredBase = configuredBase;
        this.base = resolveBaseBranch(refs, configuredBase);
        this.mainBranchName = resolveMainBranchName(refs);
        return true;
    }
}

module.exports = { RepositoryModel };
