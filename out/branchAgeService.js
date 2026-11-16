// @ts-check
'use strict';

const vscode = require('vscode');
const { describeGitError, execGit } = require('./gitCli');
const { classifyBranch } = require('./branchStatus');
const { findBranchPoint } = require('./branchPoint');
const {
    shortSha,
} = require('./branchRefs');

/**
 * @typedef {import('./branchRefs').Branch} Branch
 * @typedef {import('./repositoryModel').RepositoryModel} RepositoryModel
 */

/**
 * Where an age comes from: `none` — no commits and no reflog entry, `error` — reading the history failed.
 *
 * @typedef {'none' | 'error' | 'firstCommit' | 'branchLine' | 'reflog' | 'tip' | 'historyRoot'} AgeSource
 */

/**
 * @typedef {object} BranchAge
 * @property {'pending' | 'resolved'} state
 * @property {number | undefined} since unix seconds
 * @property {AgeSource} source
 * @property {boolean} [predatesDefault]
 * @property {boolean} isMerged
 * @property {'same' | 'empty' | 'merged' | 'synced' | 'diverged'} [status]
 */

/**
 * @typedef {object} AgeResolution
 * @property {string} rootPath
 * @property {string} refname
 */

/**
 * @typedef {object} AgeJob
 * @property {string} key
 * @property {RepositoryModel} model
 * @property {Branch} branch
 */

/**
 * @typedef {object} BaseLine
 * @property {string} sha base tip the line was read from
 * @property {Promise<Set<string>>} shas commits of the first-parent line of the base
 */

/**
 * @typedef {object} ForkPoint
 * @property {string} sha short sha
 * @property {number} date committer date, unix seconds
 */

const MAX_PARALLEL_GIT = 4;
/** @type {Readonly<BranchAge>} */
const AGE_PENDING = Object.freeze({ state: 'pending', since: undefined, source: 'none', isMerged: false });
/** @type {Readonly<BranchAge>} */
const AGE_FAILED = Object.freeze({ state: 'resolved', since: undefined, source: 'error', isMerged: false });

/**
 * Возраст от исходной точки first-parent-ответвления, без сдвига при подливании базы.
 */
class BranchAgeService {
    /** @type {string} */
    #gitPath;
    /** @type {vscode.LogOutputChannel} */
    #log;
    /** @type {Map<string, Readonly<BranchAge>>} */
    #results = new Map();
    /** @type {Set<string>} */
    #queuedKeys = new Set();
    /** @type {Map<string, BaseLine>} by repository root */
    #baseLines = new Map();
    /** @type {AgeJob[]} */
    #queue = [];
    #running = 0;
    /** @type {vscode.EventEmitter<AgeResolution>} */
    #onDidResolve = new vscode.EventEmitter();

    /**
     * @param {string} gitPath
     * @param {vscode.LogOutputChannel} log
     */
    constructor(gitPath, log) {
        this.#gitPath = gitPath;
        this.#log = log;
    }

    /**
     * @returns {vscode.Event<AgeResolution>}
     */
    get onDidResolve() {
        return this.#onDidResolve.event;
    }

    /**
     * @param {RepositoryModel} model
     * @param {Branch} branch
     * @returns {Readonly<BranchAge>} the cached age, or pending while it is computed
     */
    ageOf(model, branch) {
        const key = this.#keyOf(model, branch);
        const result = this.#results.get(key);
        if (result !== undefined) {
            return result;
        }
        if (!this.#queuedKeys.has(key)) {
            this.#queuedKeys.add(key);
            this.#queue.push({ key, model, branch });
            this.#pump();
        }
        return AGE_PENDING;
    }

    /**
     * @param {RepositoryModel} model with a resolved base
     * @param {Branch} branch
     * @returns {Promise<ForkPoint>}
     */
    async forkPointOf(model, branch) {
        if (model.base === undefined) {
            throw new Error('The base branch is not resolved.');
        }
        const point = await this.#readBranchPoint(model, branch);
        if (point === undefined) {
            throw new Error('Исходная точка ответвления не найдена.');
        }
        return { sha: shortSha(point.sha), date: point.date };
    }

    /**
     * Drops cached ages of the branches the repository no longer has.
     *
     * @param {RepositoryModel} model
     * @returns {void}
     */
    retain(model) {
        const prefix = `${model.rootPath}\0`;
        const currentKeys = new Set(model.branches.map((branch) => this.#keyOf(model, branch)));
        for (const key of this.#results.keys()) {
            if (key.startsWith(prefix) && !currentKeys.has(key)) {
                this.#results.delete(key);
            }
        }
    }

    /**
     * @param {string} rootPath
     * @returns {void}
     */
    forget(rootPath) {
        this.#baseLines.delete(rootPath);
        const prefix = `${rootPath}\0`;
        for (const key of this.#results.keys()) {
            if (key.startsWith(prefix)) {
                this.#results.delete(key);
            }
        }
    }

    /**
     * @returns {void}
     */
    dispose() {
        this.#queue = [];
        this.#onDidResolve.dispose();
    }

    /**
     * @param {RepositoryModel} model
     * @param {Branch} branch
     * @returns {string}
     */
    #keyOf(model, branch) {
        return [model.rootPath, model.base?.sha ?? '', model.mainBranchName ?? '', branch.refname, branch.sha].join('\0');
    }

    /**
     * @returns {void}
     */
    #pump() {
        while (this.#running < MAX_PARALLEL_GIT && this.#queue.length > 0) {
            const job = this.#queue.shift();
            if (job === undefined) {
                break;
            }
            this.#running += 1;
            this.#compute(job.model, job.branch)
                .catch((error) => {
                    this.#log.warn(`Age of ${job.branch.refname} in ${job.model.rootPath}: ${describeGitError(error)}`);
                    return AGE_FAILED;
                })
                .then((result) => {
                    this.#results.set(job.key, result);
                    this.#queuedKeys.delete(job.key);
                    this.#running -= 1;
                    this.#onDidResolve.fire({ rootPath: job.model.rootPath, refname: job.branch.refname });
                    this.#pump();
                });
        }
    }

    /**
     * @param {RepositoryModel} model with a resolved base
     * @param {Branch} branch
     * @returns {Promise<BranchAge>}
     */
    async #compute(model, branch) {
        if (model.isMainBranch(branch)) {
            const roots = await execGit(this.#gitPath, model.rootPath, [
                'log', '--first-parent', '--format=%ct', branch.sha, '--',
            ]);
            const timestamp = roots.trim().split('\n').pop();
            const since = timestamp !== undefined && /^\d+$/.test(timestamp) ? Number(timestamp) : undefined;
            return resolvedAge(since, since === undefined ? 'none' : 'historyRoot', false);
        }
        if (model.base === undefined) {
            throw new Error('The base branch is not resolved.');
        }
        const point = await this.#readBranchPoint(model, branch);
        const own = await execGit(this.#gitPath, model.rootPath, [
            'rev-list', '--max-count=1', `${model.base.sha}..${branch.sha}`, '--',
        ]);
        const behind = await execGit(this.#gitPath, model.rootPath, [
            'rev-list', '--max-count=1', `${branch.sha}..${model.base.sha}`, '--',
        ]);
        const baseLine = await execGit(this.#gitPath, model.rootPath, [
            'rev-list', '--first-parent', model.base.sha, '--',
        ]);
        const defaultBranch = model.branches.find((candidate) => model.isMainBranch(candidate));
        let defaultStart;
        if (defaultBranch !== undefined) {
            const dates = await execGit(this.#gitPath, model.rootPath, [
                'log', '--first-parent', '--format=%ct', defaultBranch.sha, '--',
            ]);
            defaultStart = Number(dates.trim().split('\n').pop());
        }
        const predatesDefault = point !== undefined && defaultStart !== undefined && point.date < defaultStart;
        const status = classifyBranch(branch.sha === model.base.sha, own.trim() !== '', behind.trim() !== '',
            baseLine.trim().split('\n').includes(branch.sha));
        return { ...resolvedAge(point?.date, point === undefined ? 'none' : 'branchLine', status === 'merged'),
            status, predatesDefault };

    }

    /**
     * @param {RepositoryModel} model
     * @param {Branch} branch
     * @returns {Promise<{sha: string, date: number} | undefined>}
     */
    async #readBranchPoint(model, branch) {
        if (model.base === undefined || branch.sha === model.base.sha) {
            return undefined;
        }
        const readLine = (/** @type {string} */ sha) => execGit(this.#gitPath, model.rootPath, [
            'log', '--first-parent', '--format=%H %ct', sha, '--',
        ]);
        const [branchLog, baseLog] = await Promise.all([readLine(branch.sha), readLine(model.base.sha)]);
        const point = findBranchPoint(branchLog, baseLog);
        if (point !== undefined) {
            return point;
        }
        const merges = await execGit(this.#gitPath, model.rootPath, [
            'log', '--first-parent', '--merges', '--format=%P', branch.sha, '--',
        ]);
        for (const parents of merges.trim().split('\n')) {
            const [, ...incoming] = parents.split(' ');
            for (const parent of incoming) {
                const candidate = findBranchPoint(branchLog, await readLine(parent));
                if (candidate !== undefined) {
                    return candidate;
                }
            }
        }
        return undefined;
    }
}

/**
 * @param {number | undefined} since
 * @param {AgeSource} source
 * @param {boolean} isMerged
 * @returns {BranchAge}
 */
function resolvedAge(since, source, isMerged) {
    return { state: 'resolved', since, source, isMerged };
}

module.exports.BranchAgeService = BranchAgeService;
