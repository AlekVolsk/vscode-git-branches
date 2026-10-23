'use strict';

const vscode = require('vscode');
const { BranchDecorationProvider } = require('./branchDecorationProvider');
const { createNameMatcher, parseFilterWords } = require('./branchFilter');
const { describeGitError } = require('./gitCli');
const { RepositoryModel } = require('./repositoryModel');
const {
    describeUpstream,
    formatAge,
    formatDate,
    isOlderThanMonths,
    shortSha,
    shortenRefName,
} = require('./branchRefs');

const REFRESH_DELAY_MS = 400;
const AGE_REDRAW_DELAY_MS = 100;
const PENDING_AGE_TEXT = '…';
const MERGED_TEXT = 'merged';
const AGE_SOURCE_TEXT = Object.freeze({
    firstCommit: 'first own commit',
    branchLine: 'first commit of the branch line',
    reflog: 'branch created, from reflog',
    tip: 'its last commit; the branch has no line of its own',
});
const STALE_AFTER_MONTHS = 6;
const PRIMARY_REMOTE = 'origin';
const OPEN_BRANCH_COMMAND = 'gitBranches.openBranch';
const EDIT_FILTER_COMMAND = 'gitBranches.editFilter';
const FILTER_NODE_ID = 'filter';
const FILTER_PLACEHOLDER = 'Filter branches…';

/**
 * Branches tree: the filter row, a node per repository when more than one is open, then the Local group
 * and a group per remote.
 */
class BranchTreeProvider {
    #gitPath;
    #ages;
    #log;
    #view = undefined;
    #filterWords = [];
    #matchName = undefined;
    #filterGeneration = 0;
    #models = new Map();
    #modelSubscriptions = new Map();
    #firstLoads = new Map();
    #refreshChains = new Map();
    #refreshTimers = new Map();
    #dirtyModels = new Set();
    #nodes = new Map();
    #ageRedrawNodes = new Set();
    #ageRedrawTimer = undefined;
    #onDidChangeTreeData = new vscode.EventEmitter();
    #subscriptions = [];

    constructor(gitPath, ages, log) {
        this.#gitPath = gitPath;
        this.#ages = ages;
        this.#log = log;
        this.#subscriptions.push(ages.onDidResolve(({ rootPath, refname }) => this.#queueAgeRedraw(rootPath, refname)));
    }

    get onDidChangeTreeData() {
        return this.#onDidChangeTreeData.event;
    }

    attachView(view) {
        this.#view = view;
        this.#subscriptions.push(view.onDidChangeVisibility(({ visible }) => {
            if (!visible) {
                return;
            }
            for (const model of this.#dirtyModels) {
                this.#scheduleRefresh(model);
            }
        }));
    }

    addRepository(repository) {
        if (this.#models.has(repository)) {
            return;
        }
        const model = new RepositoryModel(repository, this.#gitPath);
        this.#models.set(repository, model);
        this.#modelSubscriptions.set(repository, repository.state.onDidChange(() => this.#scheduleRefresh(model)));
        this.#firstLoads.set(model, this.#refreshModel(model));
        this.#onDidChangeTreeData.fire(undefined);
    }

    removeRepository(repository) {
        const model = this.#models.get(repository);
        if (model === undefined) {
            return;
        }
        this.#modelSubscriptions.get(repository).dispose();
        this.#modelSubscriptions.delete(repository);
        clearTimeout(this.#refreshTimers.get(model));
        this.#refreshTimers.delete(model);
        this.#models.delete(repository);
        this.#firstLoads.delete(model);
        this.#refreshChains.delete(model);
        this.#dirtyModels.delete(model);
        for (const [id, node] of this.#nodes) {
            if (node.model === model) {
                this.#nodes.delete(id);
            }
        }
        this.#ages.forget(model.rootPath);
        this.#onDidChangeTreeData.fire(undefined);
    }

    get models() {
        return [...this.#models.values()];
    }

    refreshAll() {
        for (const model of this.#models.values()) {
            model.invalidate();
            void this.#refreshModel(model);
        }
    }

    refreshRepository(model) {
        return this.#refreshModel(model);
    }

    get filterText() {
        return this.#filterWords.join(' ');
    }

    get filterSummaryText() {
        const branches = this.models.flatMap((model) => model.branches);
        if (this.#matchName === undefined) {
            return `${branches.length} branches`;
        }
        const matchedCount = branches.filter((branch) => this.#matchName(branch.name) !== undefined).length;
        return matchedCount === 0 ? 'no matches' : `${matchedCount} of ${branches.length}`;
    }

    /**
     * Repository and group nodes get new ids for every filter, so VS Code shows them expanded
     * instead of in the state it remembers for the id; branch ids stay the same.
     */
    setFilter(text) {
        const words = parseFilterWords(text);
        if (words.join(' ') === this.filterText) {
            return;
        }
        this.#filterWords = words;
        this.#matchName = createNameMatcher(words);
        this.#filterGeneration += 1;
        for (const [id, node] of this.#nodes) {
            if (node.isFiltered === true) {
                this.#nodes.delete(id);
            }
        }
        this.#onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(node) {
        switch (node.type) {
            case 'filter':
                return this.#filterItem(node);
            case 'repository':
                return this.#repositoryItem(node);
            case 'localGroup':
                return this.#groupItem(node, 'Local', 'device-desktop', true);
            case 'remoteGroup':
                return this.#groupItem(node, node.remoteName, 'cloud', false);
            default:
                return this.#branchItem(node);
        }
    }

    async getChildren(node) {
        if (node === undefined) {
            await Promise.all(this.#firstLoads.values());
            const models = [...this.#models.values()]
                .sort((left, right) => left.rootPath.localeCompare(right.rootPath));
            if (models.length === 0) {
                return [];
            }
            const filterNode = this.#node(FILTER_NODE_ID, { type: 'filter' });
            if (models.length === 1) {
                return [filterNode, ...this.#groupNodes(models[0])];
            }
            const repositoryNodes = models
                .filter((model) => this.#hasShownBranches(model.branches))
                .map((model) => this.#scopedNode(`repository:${model.rootPath}`, { type: 'repository', model }));
            return [filterNode, ...repositoryNodes];
        }
        switch (node.type) {
            case 'repository':
                return this.#groupNodes(node.model);
            case 'localGroup':
            case 'remoteGroup':
                return this.#shownBranchesOf(node).map((branch) => this.#branchNode(node.model, branch));
            default:
                return [];
        }
    }

    async resolveTreeItem(item, node) {
        if (node.type === 'branch') {
            item.tooltip = await this.#branchTooltip(node.model, node.branch);
        }
        return item;
    }

    dispose() {
        clearTimeout(this.#ageRedrawTimer);
        for (const timer of this.#refreshTimers.values()) {
            clearTimeout(timer);
        }
        for (const subscription of [...this.#modelSubscriptions.values(), ...this.#subscriptions]) {
            subscription.dispose();
        }
        this.#onDidChangeTreeData.dispose();
    }

    #scheduleRefresh(model) {
        if (this.#view !== undefined && !this.#view.visible) {
            this.#dirtyModels.add(model);
            return;
        }
        clearTimeout(this.#refreshTimers.get(model));
        this.#refreshTimers.set(model, setTimeout(() => {
            this.#refreshTimers.delete(model);
            void this.#refreshModel(model);
        }, REFRESH_DELAY_MS));
    }

    #refreshModel(model) {
        const previous = this.#refreshChains.get(model) ?? Promise.resolve();
        const next = previous.then(() => this.#readModel(model));
        this.#refreshChains.set(model, next);
        return next;
    }

    async #readModel(model) {
        this.#dirtyModels.delete(model);
        let isChanged;
        try {
            isChanged = await model.refresh();
        } catch (error) {
            this.#log.error(`Reading branches of ${model.rootPath}: ${describeGitError(error)}`);
            return;
        }
        if (!isChanged || !this.#models.has(model.repository)) {
            return;
        }
        this.#ages.retain(model);
        this.#pruneNodes(model);
        if (this.#models.size === 1 || this.#matchName !== undefined) {
            this.#onDidChangeTreeData.fire(undefined);
            return;
        }
        this.#onDidChangeTreeData.fire(this.#nodes.get(`repository:${model.rootPath}`) ?? undefined);
    }

    #pruneNodes(model) {
        const refnames = new Set(model.branches.map((branch) => branch.refname));
        for (const [id, node] of this.#nodes) {
            if (node.model !== model) {
                continue;
            }
            const isGoneBranch = node.type === 'branch' && !refnames.has(node.branch.refname);
            const isGoneRemote = node.type === 'remoteGroup' && !model.remotes.has(node.remoteName);
            if (isGoneBranch || isGoneRemote) {
                this.#nodes.delete(id);
            }
        }
    }

    #node(id, fields) {
        let node = this.#nodes.get(id);
        if (node === undefined) {
            node = { id, ...fields };
            this.#nodes.set(id, node);
        }
        return node;
    }

    #scopedNode(id, fields) {
        if (this.#matchName === undefined) {
            return this.#node(id, fields);
        }
        return this.#node(`${id}|filter:${this.#filterGeneration}`, { ...fields, isFiltered: true });
    }

    #groupNodes(model) {
        const remoteNames = [...model.remotes.keys()].sort((left, right) => {
            if (left === PRIMARY_REMOTE || right === PRIMARY_REMOTE) {
                return left === PRIMARY_REMOTE ? -1 : 1;
            }
            return left.localeCompare(right);
        });
        const groupNodes = [
            this.#scopedNode(`local:${model.rootPath}`, { type: 'localGroup', model }),
            ...remoteNames.map((remoteName) => this.#scopedNode(
                `remote:${model.rootPath}:${remoteName}`,
                { type: 'remoteGroup', model, remoteName },
            )),
        ];
        return groupNodes.filter((groupNode) => this.#hasShownBranches(this.#branchesOf(groupNode)));
    }

    #branchNode(model, branch) {
        const node = this.#node(`branch:${model.rootPath}:${branch.refname}`, { type: 'branch', model });
        node.branch = branch;
        return node;
    }

    #branchesOf(groupNode) {
        if (groupNode.type === 'localGroup') {
            return groupNode.model.local;
        }
        return groupNode.model.remotes.get(groupNode.remoteName) ?? [];
    }

    #shownBranchesOf(groupNode) {
        return this.#branchesOf(groupNode).filter((branch) => this.#isShown(branch));
    }

    /**
     * Without a filter an empty repository or group is still shown.
     */
    #hasShownBranches(branches) {
        return this.#matchName === undefined || branches.some((branch) => this.#isShown(branch));
    }

    #isShown(branch) {
        return this.#matchName === undefined || this.#matchName(branch.name) !== undefined;
    }

    #filterItem(node) {
        const isFiltering = this.#matchName !== undefined;
        const item = new vscode.TreeItem(this.filterText, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.description = isFiltering ? this.filterSummaryText : FILTER_PLACEHOLDER;
        item.tooltip = isFiltering
            ? 'Branches whose names contain every word. Click to change.'
            : 'Click to filter the branches by name.';
        item.iconPath = new vscode.ThemeIcon(isFiltering ? 'filter-filled' : 'search');
        item.contextValue = isFiltering ? 'filter.active' : 'filter';
        item.command = { command: EDIT_FILTER_COMMAND, title: 'Filter branches…' };
        return item;
    }

    #repositoryItem(node) {
        const item = new vscode.TreeItem(node.model.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.description = node.model.headDescription;
        item.tooltip = node.model.rootPath;
        item.iconPath = new vscode.ThemeIcon('repo');
        item.contextValue = 'repository';
        return item;
    }

    #groupItem(node, label, icon, isExpanded) {
        const isFiltered = node.isFiltered === true;
        const state = isExpanded || isFiltered
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed;
        const branchCount = this.#branchesOf(node).length;
        const item = new vscode.TreeItem(label, state);
        item.id = node.id;
        item.description = isFiltered ? `${this.#shownBranchesOf(node).length} / ${branchCount}` : String(branchCount);
        item.tooltip = node.type === 'localGroup'
            ? `${branchCount} local branches`
            : `${branchCount} branches on ${node.remoteName}`;
        item.iconPath = new vscode.ThemeIcon(icon);
        item.contextValue = node.type;
        return item;
    }

    #branchItem(node) {
        const { model, branch } = node;
        const age = this.#ageOf(model, branch);
        const kind = branchKindOf(branch, age);
        const item = new vscode.TreeItem(this.#branchLabel(branch, kind), vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.description = branchDescriptionOf(branch, age);
        const color = new vscode.ThemeColor(BranchDecorationProvider.colorIdFor(kind));
        item.iconPath = new vscode.ThemeIcon(branchIconOf(branch), color);
        item.resourceUri = BranchDecorationProvider.uriFor(kind, node.id);
        item.contextValue = branchContextOf(branch, model.isMainBranch(branch));
        item.command = { command: OPEN_BRANCH_COMMAND, title: 'Checkout on double click', arguments: [node] };
        return item;
    }

    /**
     * The current branch is bold through a highlight over the whole label, so filter matches
     * are highlighted only in the other branches.
     */
    #branchLabel(branch, kind) {
        if (kind === 'current') {
            return { label: branch.name, highlights: [[0, branch.name.length]] };
        }
        const highlights = this.#matchName?.(branch.name);
        return highlights === undefined ? branch.name : { label: branch.name, highlights };
    }

    #ageOf(model, branch) {
        if (model.base === undefined || model.isBaseLike(branch)) {
            return undefined;
        }
        return this.#ages.ageOf(model, branch);
    }

    async #branchTooltip(model, branch) {
        const tooltip = new vscode.MarkdownString(undefined, true);
        const appendLine = (label, text) => {
            tooltip.appendMarkdown(`${label}: `);
            tooltip.appendText(text);
            tooltip.appendMarkdown('  \n');
        };

        tooltip.appendMarkdown('**');
        tooltip.appendText(branch.name);
        tooltip.appendMarkdown('**  \n');
        tooltip.appendText(branch.kind === 'local' ? 'local branch' : `branch on ${branch.remoteName}`);
        if (model.isMainBranch(branch)) {
            tooltip.appendText(' · main branch, cannot be deleted');
        }
        tooltip.appendMarkdown('\n\n');

        if (branch.kind === 'local') {
            appendLine('Upstream', describeUpstreamInFull(branch));
            if (branch.isInOtherWorktree) {
                appendLine('Checked out in worktree', branch.worktreePath);
            }
        }
        appendLine('Last commit', `${shortSha(branch.sha)} ${branch.subject}`);
        appendLine('Committed', `${formatDate(branch.committerDate)} by ${branch.author}`);
        tooltip.appendMarkdown('\n');

        if (model.base === undefined) {
            const reason = model.configuredBase === ''
                ? 'not resolved — set gitBranches.baseBranch'
                : `${model.configuredBase} from gitBranches.baseBranch not found`;
            appendLine('Base', reason);
            return tooltip;
        }
        appendLine('Base', shortenRefName(model.base.refname));
        if (model.isBaseLike(branch)) {
            return tooltip;
        }
        appendLine('Fork point', await this.#forkPointText(model, branch));
        const baseName = shortenRefName(model.base.refname);
        const age = this.#ages.ageOf(model, branch);
        appendLine('Age', ageInFull(age, branch, baseName));
        if (age.isMerged) {
            appendLine('Merged', `its tip is already in ${baseName}`);
        }
        return tooltip;
    }

    async #forkPointText(model, branch) {
        try {
            const forkPoint = await this.#ages.forkPointOf(model, branch);
            return `${forkPoint.sha}, ${formatDate(forkPoint.date)}`;
        } catch (error) {
            this.#log.warn(`Fork point of ${branch.refname} in ${model.rootPath}: ${describeGitError(error)}`);
            return 'no common history with the base';
        }
    }

    #queueAgeRedraw(rootPath, refname) {
        const node = this.#nodes.get(`branch:${rootPath}:${refname}`);
        if (node === undefined) {
            return;
        }
        this.#ageRedrawNodes.add(node);
        if (this.#ageRedrawTimer !== undefined) {
            return;
        }
        this.#ageRedrawTimer = setTimeout(() => {
            this.#ageRedrawTimer = undefined;
            const nodes = [...this.#ageRedrawNodes];
            this.#ageRedrawNodes.clear();
            this.#onDidChangeTreeData.fire(nodes);
        }, AGE_REDRAW_DELAY_MS);
    }
}

function branchKindOf(branch, age) {
    if (branch.kind === 'local' && branch.isHead) {
        return 'current';
    }
    if (age?.isMerged === true) {
        return 'merged';
    }
    if (age?.since !== undefined && isOlderThanMonths(age.since, nowSeconds(), STALE_AFTER_MONTHS)) {
        return 'stale';
    }
    return branch.kind;
}

function ageTextOf(age) {
    if (age === undefined) {
        return '';
    }
    if (age.state === 'pending') {
        return PENDING_AGE_TEXT;
    }
    return age.since === undefined ? '' : formatAge(age.since, nowSeconds());
}

function branchDescriptionOf(branch, age) {
    const parts = [ageTextOf(age), age?.isMerged === true ? MERGED_TEXT : ''];
    if (branch.kind === 'local') {
        parts.push(describeUpstream(branch));
    }
    return parts.filter((part) => part !== '').join(' · ');
}

function branchIconOf(branch) {
    if (branch.kind === 'local' && branch.isHead) {
        return 'check';
    }
    return branch.kind === 'local' && branch.isInOtherWorktree ? 'worktree' : 'git-branch';
}

function branchContextOf(branch, isMainBranch) {
    const mainSuffix = isMainBranch ? '.main' : '';
    if (branch.kind === 'remote') {
        return `branch.remote${mainSuffix}`;
    }
    if (branch.isHead) {
        return `branch.local.current${mainSuffix}`;
    }
    return `${branch.isInOtherWorktree ? 'branch.local.worktree' : 'branch.local'}${mainSuffix}`;
}

function describeUpstreamInFull(branch) {
    if (branch.upstream === undefined) {
        return 'none';
    }
    if (branch.isUpstreamGone) {
        return `${branch.upstream} (gone)`;
    }
    if (branch.ahead === 0 && branch.behind === 0) {
        return `${branch.upstream}, in sync`;
    }
    return `${branch.upstream}, ahead ${branch.ahead}, behind ${branch.behind}`;
}

function ageInFull(age, branch, baseName) {
    if (age.state === 'pending') {
        return 'calculating…';
    }
    if (age.source === 'error') {
        return 'unknown — reading the history failed, see the Git Branches output';
    }
    if (age.since === undefined) {
        const reflog = branch.kind === 'local' ? ' and no creation entry in the reflog' : '';
        return `unknown — the branch points at ${baseName} itself, with no commits yet${reflog}`;
    }
    return `${formatAge(age.since, nowSeconds())}, since ${formatDate(age.since)} (${AGE_SOURCE_TEXT[age.source]})`;
}

function nowSeconds() {
    return Math.floor(Date.now() / 1_000);
}

module.exports = { BranchTreeProvider };
