// @ts-check
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

/**
 * @typedef {import('./branchRefs').Branch} Branch
 * @typedef {import('./branchRefs').LocalBranch} LocalBranch
 * @typedef {import('./branchRefs').RemoteBranch} RemoteBranch
 */

/**
 * The part of the `HEAD` of the Git extension API that is read here.
 *
 * @typedef {object} GitHead
 * @property {string | undefined} [name]
 * @property {string | undefined} [commit]
 */

/**
 * @typedef {object} GitRepositoryState
 * @property {GitHead | undefined} HEAD
 * @property {ReadonlyArray<{readonly name: string}>} remotes
 * @property {import('vscode').Event<void>} onDidChange
 */

/**
 * @typedef {object} GitFetchOptions
 * @property {string} [remote]
 * @property {string} [ref]
 * @property {boolean} [all]
 * @property {boolean} [prune]
 */

/**
 * @typedef {object} GitProtectedBranchQuery
 * @property {string} name
 * @property {{remote: string, name: string | undefined} | undefined} upstream
 */

/**
 * The part of a repository of the Git extension API (`vscode.git`, API version 1) that is used here.
 *
 * @typedef {object} GitRepository
 * @property {import('vscode').Uri} rootUri
 * @property {GitRepositoryState} state
 * @property {(name: string, checkout: boolean, ref?: string) => Promise<void>} createBranch
 * @property {(name: string, upstream: string) => Promise<void>} setBranchUpstream
 * @property {(treeish: string) => Promise<void>} checkout
 * @property {(name: string, force?: boolean) => Promise<void>} deleteBranch
 * @property {(remoteName?: string, branchName?: string, setUpstream?: boolean) => Promise<void>} push
 * @property {() => Promise<void>} pull
 * @property {(options: GitFetchOptions) => Promise<void>} fetch
 * @property {((branch: GitProtectedBranchQuery) => boolean) | undefined} [isBranchProtected] missing in older VS Code
 */

/**
 * The branches of one repository, read with a single `git for-each-ref`, and its resolved base branch.
 */
class RepositoryModel {
    /** @type {GitRepository} */
    repository;
    /** @type {string} */
    rootPath;
    /** @type {string} */
    name;
    /** @type {LocalBranch[]} */
    local = [];
    /** @type {Map<string, RemoteBranch[]>} by remote name */
    remotes = new Map();
    /** @type {Branch | undefined} */
    base = undefined;
    /** @type {string} `gitBranches.baseBranch` of the last read, trimmed */
    configuredBase = '';
    /** @type {string | undefined} */
    mainBranchName = undefined;
    /** @type {string} */
    #gitPath;
    /** @type {string} */
    #signature = '';

    /**
     * @param {GitRepository} repository
     * @param {string} gitPath
     */
    constructor(repository, gitPath) {
        this.repository = repository;
        this.rootPath = repository.rootUri.fsPath;
        this.name = path.basename(this.rootPath);
        this.#gitPath = gitPath;
    }

    /**
     * @returns {string} the branch name, `detached at <sha>`, or empty
     */
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

    /**
     * @returns {Branch[]}
     */
    get branches() {
        return [...this.local, ...[...this.remotes.values()].flat()];
    }

    /**
     * @param {Branch} branch
     * @returns {boolean}
     */
    isBaseLike(branch) {
        return this.base !== undefined && branch.name === this.base.name;
    }

    /**
     * The main branch is the default branch of the remote, by name, locally and on every remote.
     *
     * @param {Branch} branch
     * @returns {boolean}
     */
    isMainBranch(branch) {
        return this.mainBranchName !== undefined && branch.name === this.mainBranchName;
    }

    /**
     * @returns {void}
     */
    invalidate() {
        this.#signature = '';
    }

    /**
     * @returns {Promise<boolean>} whether anything shown differs from the previous read
     */
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

module.exports.RepositoryModel = RepositoryModel;
