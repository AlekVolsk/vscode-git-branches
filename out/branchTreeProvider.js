// @ts-check
'use strict';

const vscode = require('vscode');
const { statisticsCategory, isStaleBranch } = require('./branchStatistics');
const { BranchDecorationProvider } = require('./branchDecorationProvider');
const { createNameMatcher, parseFilterWords } = require('./branchFilter');
const { describeGitError } = require('./gitCli');
const { RepositoryModel } = require('./repositoryModel');
const {
    describeUpstream,
    formatAge,
    formatDate,
    shortSha,
    shortenRefName,
} = require('./branchRefs');

/**
 * @typedef {import('./branchRefs').Branch} Branch
 * @typedef {import('./branchRefs').LocalBranch} LocalBranch
 * @typedef {import('./branchAgeService').BranchAge} BranchAge
 * @typedef {import('./branchAgeService').AgeSource} AgeSource
 * @typedef {import('./branchAgeService').BranchAgeService} BranchAgeService
 * @typedef {import('./branchDecorationProvider').BranchColorKind} BranchColorKind
 * @typedef {import('./branchFilter').NameMatcher} NameMatcher
 * @typedef {import('./repositoryModel').GitRepository} GitRepository
 */

/**
 * @typedef {{type: 'filter', model?: undefined, isFiltered?: undefined}} FilterNodeFields
 * @typedef {{type: 'repository', model: RepositoryModel, isFiltered?: true}} RepositoryNodeFields
 * @typedef {{type: 'localGroup', model: RepositoryModel, isFiltered?: true}} LocalGroupNodeFields
 * @typedef {{type: 'remoteGroup', model: RepositoryModel, remoteName: string, isFiltered?: true}} RemoteGroupNodeFields
 * @typedef {{type: 'branch', model: RepositoryModel, branch: Branch, isFiltered?: undefined}} BranchNodeFields
 * @typedef {FilterNodeFields | RepositoryNodeFields | LocalGroupNodeFields | RemoteGroupNodeFields
 *     | BranchNodeFields} TreeNodeFields
 */

/**
 * @typedef {{id: string} & FilterNodeFields} FilterNode
 * @typedef {{id: string} & RepositoryNodeFields} RepositoryNode
 * @typedef {{id: string} & LocalGroupNodeFields} LocalGroupNode
 * @typedef {{id: string} & RemoteGroupNodeFields} RemoteGroupNode
 * @typedef {{id: string} & BranchNodeFields} BranchNode
 * @typedef {LocalGroupNode | RemoteGroupNode} GroupNode
 * @typedef {FilterNode | RepositoryNode | GroupNode | BranchNode} TreeNode
 */

const REFRESH_DELAY_MS = 400;
const AGE_REDRAW_DELAY_MS = 100;
const PENDING_AGE_TEXT = '…';
const STATUS_TEXT = {
    same: 'same as base',
    empty: 'no own commits',
    merged: 'merged',
    synced: 'up to date with base',
    diverged: '',
};
/** @type {Readonly<Partial<Record<AgeSource, string>>>} */
const AGE_SOURCE_TEXT = Object.freeze({
    firstCommit: 'first own commit',
    branchLine: 'estimated branch point',
    historyRoot: 'first commit of the default branch history',
    reflog: 'branch created, from reflog',
    tip: 'its last commit; the branch has no line of its own',
});
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
    /** @type {string} */
    #gitPath;
    /** @type {BranchAgeService} */
    #ages;
    /** @type {vscode.LogOutputChannel} */
    #log;
    /** @type {vscode.TreeView<TreeNode> | undefined} */
    #view = undefined;
    /** @type {string[]} */
    #filterWords = [];
    /** @type {NameMatcher | undefined} */
    #matchName = undefined;
    #filterGeneration = 0;
    /** @type {Map<GitRepository, RepositoryModel>} */
    #models = new Map();
    /** @type {Map<GitRepository, vscode.Disposable>} */
    #modelSubscriptions = new Map();
    /** @type {Map<RepositoryModel, Promise<void>>} */
    #firstLoads = new Map();
    /** @type {Map<RepositoryModel, Promise<void>>} */
    #refreshChains = new Map();
    /** @type {Map<RepositoryModel, NodeJS.Timeout>} */
    #refreshTimers = new Map();
    /** @type {Set<RepositoryModel>} models whose refresh waits for the view to become visible */
    #dirtyModels = new Set();
    /** @type {Map<string, TreeNode>} by node id */
    #nodes = new Map();
    /** @type {Set<TreeNode>} */
    #ageRedrawNodes = new Set();
    /** @type {NodeJS.Timeout | undefined} */
    #ageRedrawTimer = undefined;
    /** @type {vscode.EventEmitter<TreeNode | TreeNode[] | undefined>} */
    #onDidChangeTreeData = new vscode.EventEmitter();
    /** @type {vscode.Disposable[]} */
    #subscriptions = [];

    /**
     * @param {string} gitPath
     * @param {BranchAgeService} ages
     * @param {vscode.LogOutputChannel} log
     */
    constructor(gitPath, ages, log) {
        this.#gitPath = gitPath;
        this.#ages = ages;
        this.#log = log;
        this.#subscriptions.push(ages.onDidResolve(({ rootPath, refname }) => this.#queueAgeRedraw(rootPath, refname)));
    }

    /**
     * @returns {vscode.Event<TreeNode | TreeNode[] | undefined>}
     */
    get onDidChangeTreeData() {
        return this.#onDidChangeTreeData.event;
    }

    /**
     * @param {vscode.TreeView<TreeNode>} view
     * @returns {void}
     */
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

    /**
     * @param {GitRepository} repository
     * @returns {void}
     */
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

    /**
     * @param {GitRepository} repository
     * @returns {void}
     */
    removeRepository(repository) {
        const model = this.#models.get(repository);
        if (model === undefined) {
            return;
        }
        this.#modelSubscriptions.get(repository)?.dispose();
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

    /**
     * @returns {RepositoryModel[]}
     */
    get models() {
        return [...this.#models.values()];
    }

    /**
     * @returns {void}
     */
    refreshAll() {
        for (const model of this.#models.values()) {
            model.invalidate();
            void this.#refreshModel(model);
        }
    }

    /**
     * @param {RepositoryModel} model
     * @returns {Promise<void>} settles once the branches are read again
     */
    refreshRepository(model) {
        return this.#refreshModel(model);
    }

    /** @type {'working' | 'new' | 'merged' | 'stale' | 'invalid' | undefined} */
    typeFilter = undefined;

    /**
     * @param {'working' | 'new' | 'merged' | 'stale' | 'invalid' | undefined} type
     * @returns {void}
     */
    setTypeFilter(type) {
        this.typeFilter = this.typeFilter === type ? undefined : type;
        void vscode.commands.executeCommand('setContext', 'gitBranches.hasStatusFilter',
            this.typeFilter !== undefined);
        this.#filterGeneration += 1;
        this.#onDidChangeTreeData.fire(undefined);
    }

    /** @returns {void} */
    clearFilters() {
        this.typeFilter = undefined;
        void vscode.commands.executeCommand('setContext', 'gitBranches.hasStatusFilter', false);
        this.setFilter('');
        this.#onDidChangeTreeData.fire(undefined);
    }

    /**
     * @param {GroupNode} node
     * @returns {Promise<void>}
     */
    async copyGroupList(node) {
        if (node?.type !== 'localGroup' && node?.type !== 'remoteGroup') {
            return;
        }
        await vscode.env.clipboard.writeText(this.#shownBranchesOf(node).map((branch) => branch.name).join('\n'));
    }

    /**
     * @returns {string} the filter words joined by single spaces
     */
    get filterText() {
        return this.#filterWords.join(' ');
    }

    /**
     * @returns {string} `N branches`, `M of N` or `no matches`
     */
    get filterSummaryText() {
        const branches = this.models.flatMap((model) => model.branches);
        if ((this.#matchName === undefined && this.typeFilter === undefined)) {
            return `${branches.length} branches`;
        }
        const matchedCount = branches.filter((branch) => this.#isShown(branch)).length;
        return matchedCount === 0 ? 'no matches' : `${matchedCount} of ${branches.length}`;
    }

    /**
     * Repository and group nodes get new ids for every filter, so VS Code shows them expanded
     * instead of in the state it remembers for the id; branch ids stay the same.
     *
     * @param {string} text
     * @returns {void}
     */
    setFilter(text) {
        const words = parseFilterWords(text);
        if (words.join(' ') === this.filterText) {
            return;
        }
        this.#filterWords = words;
        void vscode.commands.executeCommand('setContext', 'gitBranches.hasTextFilter', words.length > 0);
        this.#matchName = createNameMatcher(words);
        this.#filterGeneration += 1;
        for (const [id, node] of this.#nodes) {
            if (node.isFiltered === true) {
                this.#nodes.delete(id);
            }
        }
        this.#onDidChangeTreeData.fire(undefined);
    }

    /**
     * @param {TreeNode} node
     * @returns {vscode.TreeItem}
     */
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

    /**
     * @param {TreeNode | undefined} node `undefined` for the root
     * @returns {Promise<TreeNode[]>}
     */
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

    /**
     * @param {vscode.TreeItem} item
     * @param {TreeNode} node
     * @returns {Promise<vscode.TreeItem>}
     */
    async resolveTreeItem(item, node) {
        if (node.type === 'branch') {
            item.tooltip = await this.#branchTooltip(node.model, node.branch);
        }
        return item;
    }

    /**
     * @returns {void}
     */
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

    /**
     * @param {RepositoryModel} model
     * @returns {void}
     */
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

    /**
     * @param {RepositoryModel} model
     * @returns {Promise<void>}
     */
    #refreshModel(model) {
        const previous = this.#refreshChains.get(model) ?? Promise.resolve();
        const next = previous.then(() => this.#readModel(model));
        this.#refreshChains.set(model, next);
        return next;
    }

    /**
     * @param {RepositoryModel} model
     * @returns {Promise<void>}
     */
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
        if (this.#models.size === 1 || (this.#matchName !== undefined || this.typeFilter !== undefined)) {
            this.#onDidChangeTreeData.fire(undefined);
            return;
        }
        this.#onDidChangeTreeData.fire(this.#nodes.get(`repository:${model.rootPath}`) ?? undefined);
    }

    /**
     * @param {RepositoryModel} model
     * @returns {void}
     */
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

    /**
     * The node stored under an id, created from the fields on first use. An id starts with the node type,
     * so the stored node has the type of the fields.
     *
     * @template {TreeNodeFields} F
     * @param {string} id
     * @param {F} fields
     * @returns {F & {id: string}}
     */
    #node(id, fields) {
        let node = /** @type {(F & {id: string}) | undefined} */ (this.#nodes.get(id));
        if (node === undefined) {
            node = { id, ...fields };
            this.#nodes.set(id, node);
        }
        return node;
    }

    /**
     * @template {RepositoryNodeFields | LocalGroupNodeFields | RemoteGroupNodeFields} F
     * @param {string} id
     * @param {F} fields
     * @returns {F & {id: string}}
     */
    #scopedNode(id, fields) {
        if ((this.#matchName === undefined && this.typeFilter === undefined)) {
            return this.#node(id, fields);
        }
        return this.#node(`${id}|filter:${this.#filterGeneration}`, { ...fields, isFiltered: true });
    }

    /**
     * @param {RepositoryModel} model
     * @returns {GroupNode[]}
     */
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

    /**
     * @param {RepositoryModel} model
     * @param {Branch} branch
     * @returns {BranchNode}
     */
    #branchNode(model, branch) {
        const node = this.#node(`branch:${model.rootPath}:${branch.refname}`, { type: 'branch', model, branch });
        node.branch = branch;
        return node;
    }

    /**
     * @param {GroupNode} groupNode
     * @returns {Branch[]}
     */
    #branchesOf(groupNode) {
        if (groupNode.type === 'localGroup') {
            return groupNode.model.local;
        }
        return groupNode.model.remotes.get(groupNode.remoteName) ?? [];
    }

    /**
     * @param {GroupNode} groupNode
     * @returns {Branch[]}
     */
    #shownBranchesOf(groupNode) {
        return this.#branchesOf(groupNode).filter((branch) => this.#isShown(branch));
    }

    /**
     * Without a filter an empty repository or group is still shown.
     *
     * @param {Branch[]} branches
     * @returns {boolean}
     */
    #hasShownBranches(branches) {
        return (this.#matchName === undefined && this.typeFilter === undefined) || branches.some((branch) => this.#isShown(branch));
    }

    /**
     * @param {Branch} branch
     * @returns {boolean}
     */
    #isShown(branch) {
        if (this.#matchName !== undefined && this.#matchName(branch.name) === undefined) {
            return false;
        }
        if (this.typeFilter === undefined) {
            return true;
        }
        const model = this.models.find((candidate) => candidate.branches.includes(branch));
        if (model === undefined) {
            return false;
        }
        const configured = vscode.workspace.getConfiguration('gitBranches', model.repository.rootUri)
            .get('staleAfterDays', 180);
        const days = Number.isInteger(configured) && configured >= 1 ? configured : 180;
        const age = this.#ageOf(model, branch);
        if (this.typeFilter === 'stale') {
            return isStaleBranch(model.isMainBranch(branch), age, nowSeconds(), days);
        }
        return statisticsCategory(model.isMainBranch(branch), age, nowSeconds(), days) === this.typeFilter;
    }

    /**
     * @param {FilterNode} node
     * @returns {vscode.TreeItem}
     */
    #filterItem(node) {
        const isFiltering = (this.#matchName !== undefined || this.typeFilter !== undefined);
        const labels = { working: 'In progress', new: 'New', merged: 'Merged',
            stale: 'Stale', invalid: 'History warnings' };
        const typeLabel = this.typeFilter === undefined ? '' : labels[this.typeFilter];
        const label = [this.filterText, typeLabel].filter(Boolean).join(' · ');
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.description = isFiltering ? this.filterSummaryText : FILTER_PLACEHOLDER;
        item.tooltip = isFiltering
            ? 'Text and status filters apply together. Click to edit text; right-click to select a status or clear filters.'
            : 'Click to filter the branches by name.';
        item.iconPath = new vscode.ThemeIcon(isFiltering ? 'filter-filled' : 'search');
        item.contextValue = isFiltering ? 'filter.active' : 'filter';
        item.command = { command: EDIT_FILTER_COMMAND, title: 'Filter branches…' };
        return item;
    }

    /**
     * @param {RepositoryNode} node
     * @returns {vscode.TreeItem}
     */
    #repositoryItem(node) {
        const item = new vscode.TreeItem(node.model.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.description = node.model.headDescription;
        item.tooltip = node.model.rootPath;
        item.iconPath = new vscode.ThemeIcon('repo');
        item.contextValue = 'repository';
        return item;
    }

    /**
     * @param {GroupNode} node
     * @param {string} label
     * @param {string} icon codicon id
     * @param {boolean} isExpanded
     * @returns {vscode.TreeItem}
     */
    #groupItem(node, label, icon, isExpanded) {
        const isFiltered = node.isFiltered === true;
        const state = isExpanded || isFiltered
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed;
        const branchCount = this.#branchesOf(node).length;
        const item = new vscode.TreeItem(label, state);
        item.id = node.id;
        item.description = isFiltered ? `${this.#shownBranchesOf(node).length} / ${branchCount}` : String(branchCount);
        item.tooltip = this.#statisticsTooltip(node.model, this.#shownBranchesOf(node), label);
        item.iconPath = new vscode.ThemeIcon(icon);
        item.contextValue = node.type;
        return item;
    }

    /**
     * @param {RepositoryModel} model
     * @param {Branch[]} branches
     * @param {string} title
     * @returns {vscode.MarkdownString}
     */
    #statisticsTooltip(model, branches, title) {
        const configured = vscode.workspace.getConfiguration('gitBranches', model.repository.rootUri)
            .get('staleAfterDays', 180);
        const days = Number.isInteger(configured) && configured >= 1 ? configured : 180;
        const counts = { working: 0, new: 0, merged: 0, stale: 0, invalid: 0, pending: 0 };
        const now = nowSeconds();
        for (const branch of branches) {
            const age = this.#ageOf(model, branch);
            const isDefault = model.isMainBranch(branch);
            const category = statisticsCategory(isDefault, age, now, days);
            if (category !== 'stale') {
                counts[category] += 1;
            }
            if (isStaleBranch(isDefault, age, now, days)) {
                counts.stale += 1;
            }
        }
        const tooltip = new vscode.MarkdownString();
        tooltip.appendText(title);
        tooltip.appendMarkdown('\n\n');
        const lines = [
            `Branches: ${branches.length}${(this.#matchName === undefined && this.typeFilter === undefined) ? '' : ' (filtered)'}`,
            `In progress: ${counts.working}`,
            `New: ${counts.new}`,
            `Merged: ${counts.merged}`,
            `Stale (${days}+ days): ${counts.stale}`,
            `History warnings: ${counts.invalid}`,
        ];
        if (counts.pending > 0) {
            lines.push(`Calculating: ${counts.pending}`);
        }
        for (const line of lines) {
            tooltip.appendText(line);
            tooltip.appendMarkdown('  \n');
        }
        return tooltip;
    }

    /**
     * @param {BranchNode} node
     * @returns {vscode.TreeItem}
     */
    #branchItem(node) {
        const { model, branch } = node;
        const age = this.#ageOf(model, branch);
        const kind = branchKindOf(branch, age, model);
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
     * @param {Branch} branch
     * @param {BranchColorKind} kind
     * @returns {string | vscode.TreeItemLabel}
     */
    #branchLabel(branch, kind) {
        const highlights = this.#matchName?.(branch.name);
        return highlights === undefined ? branch.name : { label: branch.name, highlights };
    }

    /**
     * @param {RepositoryModel} model
     * @param {Branch} branch
     * @returns {Readonly<BranchAge> | undefined} Default branch history does not require a comparison base.
     */
    #ageOf(model, branch) {
        if (!model.isMainBranch(branch) && model.base === undefined) {
            return undefined;
        }
        return this.#ages.ageOf(model, branch);
    }

    /**
     * @param {RepositoryModel} model
     * @param {Branch} branch
     * @returns {Promise<vscode.MarkdownString>}
     */
    async #branchTooltip(model, branch) {
        const tooltip = new vscode.MarkdownString(undefined, true);
        /** @type {(label: string, text: string) => void} */
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
                appendLine('Checked out in worktree', branch.worktreePath ?? '');
            }
        }
        appendLine('Last commit', `${shortSha(branch.sha)} ${branch.subject}`);
        appendLine('Committed', `${formatDate(branch.committerDate)} by ${branch.author}`);
        tooltip.appendMarkdown('\n');

        if (model.isMainBranch(branch)) {
            const age = this.#ages.ageOf(model, branch);
            appendLine('Age', ageInFull(age, branch, branch.name));
            if (age.since !== undefined) {
                appendLine('History starts', formatDate(age.since));
            }
            return tooltip;
        }
        if (model.base === undefined) {
            const reason = model.configuredBase === ''
                ? 'not resolved — set gitBranches.baseBranch'
                : `${model.configuredBase} from gitBranches.baseBranch not found`;
            appendLine('Base', reason);
            return tooltip;
        }
        appendLine('Base', shortenRefName(model.base.refname));

        appendLine('Fork point', await this.#forkPointText(model, branch));
        const baseName = shortenRefName(model.base.refname);
        const age = this.#ages.ageOf(model, branch);
        appendLine('Age', ageInFull(age, branch, baseName));
        if (age.state === 'resolved' && age.since === undefined && age.status !== 'same') {
            appendLine('History warning', 'branch point unknown');
        } else if (age.predatesDefault === true) {
            appendLine('History warning', 'branch predates default branch history');
        }
        if (age.status === 'same' && age.since === undefined) {
            appendLine('Branch point', 'not distinguishable while the branch and base tips are identical');
        }
        if (age.status !== undefined && STATUS_TEXT[age.status] !== '') {
            appendLine('Status', STATUS_TEXT[age.status]);
        }
        if (age.isMerged) {
            appendLine('Merged', `its tip is already in ${baseName}`);
        }
        return tooltip;
    }

    /**
     * @param {RepositoryModel} model
     * @param {Branch} branch
     * @returns {Promise<string>}
     */
    async #forkPointText(model, branch) {
        try {
            const forkPoint = await this.#ages.forkPointOf(model, branch);
            return `${forkPoint.sha}, ${formatDate(forkPoint.date)}`;
        } catch (error) {
            this.#log.warn(`Fork point of ${branch.refname} in ${model.rootPath}: ${describeGitError(error)}`);
            return 'no common history with the base';
        }
    }

    /**
     * @param {string} rootPath
     * @param {string} refname
     * @returns {void}
     */
    #queueAgeRedraw(rootPath, refname) {
        const node = this.#nodes.get(`branch:${rootPath}:${refname}`);
        if (node === undefined) {
            return;
        }
        this.#ageRedrawNodes.add(node);
        for (const candidate of this.#nodes.values()) {
            if ((candidate.type === 'repository' || candidate.type === 'localGroup'
                || candidate.type === 'remoteGroup') && candidate.model.rootPath === rootPath) {
                this.#ageRedrawNodes.add(candidate);
            }
        }
        if (this.#ageRedrawTimer !== undefined) {
            return;
        }
        this.#ageRedrawTimer = setTimeout(() => {
            this.#ageRedrawTimer = undefined;
            const nodes = [...this.#ageRedrawNodes];
            this.#ageRedrawNodes.clear();
            this.#onDidChangeTreeData.fire(this.typeFilter === undefined ? nodes : undefined);
        }, AGE_REDRAW_DELAY_MS);
    }
}

/**
 * @param {Branch} branch
 * @param {Readonly<BranchAge> | undefined} age
 * @param {RepositoryModel} model
 * @returns {BranchColorKind}
 */
function branchKindOf(branch, age, model) {
    if (!model.isMainBranch(branch) && age?.state === 'resolved'
        && ((age.since === undefined && age.status !== 'same') || age.predatesDefault === true)) {
        return 'invalid';
    }
    const activeRemote = branch.kind === 'remote' && model.branches.some((local) =>
        local.kind === 'local' && local.isHead && local.upstreamRemote === branch.remoteName
        && local.upstreamBranch === branch.name);
    if ((branch.kind === 'local' && branch.isHead) || activeRemote) {
        return 'current';
    }
    if (model.isMainBranch(branch)) {
        return 'local';
    }
    if (age?.status === 'empty' || age?.status === 'same') {
        return 'new';
    }
    if (age?.isMerged === true) {
        return 'merged';
    }
    const configuredDays = vscode.workspace.getConfiguration('gitBranches', model.repository.rootUri)
        .get('staleAfterDays', 180);
    const days = Number.isInteger(configuredDays) && configuredDays >= 1 ? configuredDays : 180;
    if (age?.since !== undefined && nowSeconds() - age.since >= days * 86_400) {
        return 'stale';
    }
    return branch.kind;
}

/**
 * @param {Readonly<BranchAge> | undefined} age
 * @returns {string}
 */
function ageTextOf(age) {
    if (age === undefined) {
        return '';
    }
    if (age.state === 'pending') {
        return PENDING_AGE_TEXT;
    }
    return age.since === undefined ? '' : formatAge(age.since, nowSeconds());
}

/**
 * @param {Branch} branch
 * @param {Readonly<BranchAge> | undefined} age
 * @returns {string}
 */
function branchDescriptionOf(branch, age) {
    const parts = [ageTextOf(age), age?.status === undefined ? '' : STATUS_TEXT[age.status]];
    if (branch.kind === 'local') {
        parts.push(describeUpstream(branch));
    }
    return parts.filter((part) => part !== '').join(' · ');
}

/**
 * @param {Branch} branch
 * @returns {string} codicon id
 */
function branchIconOf(branch) {
    if (branch.kind === 'local' && branch.isHead) {
        return 'check';
    }
    return branch.kind === 'local' && branch.isInOtherWorktree ? 'worktree' : 'git-branch';
}

/**
 * @param {Branch} branch
 * @param {boolean} isMainBranch
 * @returns {string} `contextValue` matched by the `when` clauses of the menus
 */
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

/**
 * @param {LocalBranch} branch
 * @returns {string}
 */
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

/**
 * @param {Readonly<BranchAge>} age
 * @param {Branch} branch
 * @param {string} baseName
 * @returns {string}
 */
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

/**
 * @returns {number}
 */
function nowSeconds() {
    return Math.floor(Date.now() / 1_000);
}

module.exports.BranchTreeProvider = BranchTreeProvider;
