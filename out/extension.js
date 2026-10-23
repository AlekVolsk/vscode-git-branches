'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.activate = activate;
exports.deactivate = deactivate;

const vscode = require('vscode');
const { BranchAgeService } = require('./branchAgeService');
const { BranchCommands } = require('./branchCommands');
const { BranchDecorationProvider } = require('./branchDecorationProvider');
const { BranchFilterPrompt } = require('./branchFilterPrompt');
const { BranchTreeProvider } = require('./branchTreeProvider');
const { SkillLauncher } = require('./skillLauncher');

const VIEW_ID = 'gitBranches.view';
const SETTINGS_AFFECTING_TREE = Object.freeze(['gitBranches.baseBranch', 'git.branchSortOrder']);

async function activate(context) {
    const log = vscode.window.createOutputChannel('Git Branches', { log: true });
    context.subscriptions.push(log);

    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension === undefined) {
        log.error('The built-in Git extension is not available.');
        return;
    }
    const gitExports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    if (gitExports.enabled) {
        start(context, gitExports.getAPI(1), log);
        return;
    }

    log.info('Git is disabled by git.enabled; the Branches view starts once it is enabled.');
    const enablement = gitExports.onDidChangeEnablement((isEnabled) => {
        if (!isEnabled) {
            return;
        }
        enablement.dispose();
        start(context, gitExports.getAPI(1), log);
    });
    context.subscriptions.push(enablement);
}

function start(context, gitApi, log) {
    const ages = new BranchAgeService(gitApi.git.path, log);
    const tree = new BranchTreeProvider(gitApi.git.path, ages, log);
    const view = vscode.window.createTreeView(VIEW_ID, {
        treeDataProvider: tree,
        showCollapseAll: true,
        canSelectMany: true,
    });
    tree.attachView(view);
    for (const repository of gitApi.repositories) {
        tree.addRepository(repository);
    }
    const commands = new BranchCommands({
        tree,
        skills: new SkillLauncher(log),
        log,
        viewId: VIEW_ID,
        gitPath: gitApi.git.path,
    });
    const filterPrompt = new BranchFilterPrompt(tree);

    context.subscriptions.push(
        ...commands.register(),
        ages,
        tree,
        view,
        filterPrompt,
        vscode.window.registerFileDecorationProvider(new BranchDecorationProvider()),
        gitApi.onDidOpenRepository((repository) => tree.addRepository(repository)),
        gitApi.onDidCloseRepository((repository) => tree.removeRepository(repository)),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (SETTINGS_AFFECTING_TREE.some((setting) => event.affectsConfiguration(setting))) {
                tree.refreshAll();
            }
        }),
        vscode.commands.registerCommand('gitBranches.refresh', () => tree.refreshAll()),
        vscode.commands.registerCommand('gitBranches.editFilter', () => filterPrompt.open()),
        vscode.commands.registerCommand('gitBranches.clearFilter', () => tree.setFilter('')),
    );
}

function deactivate() {}
