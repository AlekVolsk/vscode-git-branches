'use strict';

const vscode = require('vscode');
const { describeGitError, execGit } = require('./gitCli');
const {
    BRANCH_LINE_FORMAT,
    REFLOG_FORMAT,
    parseBranchLine,
    parseOldestTimestamp,
    parseReflogCreation,
    shortSha,
} = require('./branchRefs');

const MAX_PARALLEL_GIT = 4;
const BRANCH_LINE_LIMIT = 1_000;
const AGE_PENDING = Object.freeze({ state: 'pending', since: undefined, source: 'none', isMerged: false });
const AGE_FAILED = Object.freeze({ state: 'resolved', since: undefined, source: 'error', isMerged: false });

/**
 * Branch age. A branch with commits that are not in the base: author date of the oldest of them.
 * A branch whose tip is already in the base (merged): author date of the first commit of its own
 * first-parent line, then the reflog creation entry, then the date of its tip.
 * A branch pointing at the tip of the base has no commits yet: only the reflog creation entry.
 */
class BranchAgeService {
    #gitPath;
    #log;
    #results = new Map();
    #queuedKeys = new Set();
    #baseLines = new Map();
    #queue = [];
    #running = 0;
    #onDidResolve = new vscode.EventEmitter();

    constructor(gitPath, log) {
        this.#gitPath = gitPath;
        this.#log = log;
    }

    get onDidResolve() {
        return this.#onDidResolve.event;
    }

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

    async forkPointOf(model, branch) {
        const mergeBaseArgs = ['merge-base', model.base.sha, branch.sha];
        const mergeBase = (await execGit(this.#gitPath, model.rootPath, mergeBaseArgs)).trim();
        const details = await execGit(this.#gitPath, model.rootPath, ['log', '-1', '--format=%ct', mergeBase, '--']);
        return { sha: shortSha(mergeBase), date: Number(details.trim()) };
    }

    retain(model) {
        const prefix = `${model.rootPath}\0`;
        const currentKeys = new Set(model.branches.map((branch) => this.#keyOf(model, branch)));
        for (const key of this.#results.keys()) {
            if (key.startsWith(prefix) && !currentKeys.has(key)) {
                this.#results.delete(key);
            }
        }
    }

    forget(rootPath) {
        this.#baseLines.delete(rootPath);
        const prefix = `${rootPath}\0`;
        for (const key of this.#results.keys()) {
            if (key.startsWith(prefix)) {
                this.#results.delete(key);
            }
        }
    }

    dispose() {
        this.#queue = [];
        this.#onDidResolve.dispose();
    }

    #keyOf(model, branch) {
        return [model.rootPath, model.base?.sha ?? '', branch.refname, branch.sha].join('\0');
    }

    #pump() {
        while (this.#running < MAX_PARALLEL_GIT && this.#queue.length > 0) {
            const job = this.#queue.shift();
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

    async #compute(model, branch) {
        const ownCommits = await execGit(this.#gitPath, model.rootPath, [
            'log',
            '--reverse',
            '--format=%at',
            `${model.base.sha}..${branch.sha}`,
            '--',
        ]);
        const firstOwnCommit = parseOldestTimestamp(ownCommits);
        if (firstOwnCommit !== undefined) {
            return resolvedAge(firstOwnCommit, 'firstCommit', false);
        }

        const isMerged = branch.sha !== model.base.sha;
        if (isMerged) {
            const line = await this.#readBranchLine(model, branch);
            if (line.lineStartDate !== undefined) {
                return resolvedAge(line.lineStartDate, 'branchLine', true);
            }
            const created = branch.kind === 'local' ? await this.#readCreation(model, branch) : undefined;
            if (created !== undefined) {
                return resolvedAge(created, 'reflog', true);
            }
            return resolvedAge(line.tipDate, 'tip', true);
        }

        const created = branch.kind === 'local' ? await this.#readCreation(model, branch) : undefined;
        return resolvedAge(created, created === undefined ? 'none' : 'reflog', false);
    }

    async #readBranchLine(model, branch) {
        const [baseLine, log] = await Promise.all([
            this.#baseLineOf(model),
            execGit(this.#gitPath, model.rootPath, [
                'log',
                '--first-parent',
                `--max-count=${BRANCH_LINE_LIMIT}`,
                `--format=${BRANCH_LINE_FORMAT}`,
                branch.sha,
                '--',
            ]),
        ]);
        return parseBranchLine(log, baseLine);
    }

    #baseLineOf(model) {
        const cached = this.#baseLines.get(model.rootPath);
        if (cached !== undefined && cached.sha === model.base.sha) {
            return cached.shas;
        }
        const shas = execGit(this.#gitPath, model.rootPath, ['rev-list', '--first-parent', model.base.sha])
            .then((output) => new Set(output.split('\n').filter((line) => line !== '')));
        shas.catch(() => this.#baseLines.delete(model.rootPath));
        this.#baseLines.set(model.rootPath, { sha: model.base.sha, shas });
        return shas;
    }

    async #readCreation(model, branch) {
        return parseReflogCreation(await this.#readReflog(model, branch));
    }

    async #readReflog(model, branch) {
        try {
            return await execGit(this.#gitPath, model.rootPath, [
                'reflog',
                'show',
                '--date=unix',
                `--format=${REFLOG_FORMAT}`,
                branch.refname,
                '--',
            ]);
        } catch {
            return '';
        }
    }
}

function resolvedAge(since, source, isMerged) {
    return { state: 'resolved', since, source, isMerged };
}

module.exports = { BranchAgeService };
