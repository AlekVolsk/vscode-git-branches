// @ts-check
'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { displayNameOf } = require('./branchRefs');
const { parseSkillFrontmatter, placeholderValuesFor, substitutePlaceholders } = require('./skillPrompts');

/**
 * @typedef {import('./branchRefs').Branch} Branch
 * @typedef {import('./repositoryModel').RepositoryModel} RepositoryModel
 */

/**
 * @typedef {vscode.QuickPickItem & {template?: string, isManual?: boolean}} SkillPickItem
 */

/**
 * @typedef {object} DiscoveredSkill
 * @property {string} name
 * @property {string} description
 */

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const CLAUDE_OPEN_COMMAND = 'claude-vscode.editor.open';
const DISCOVERED_SKILL_TEMPLATE = '/{name} ${branch}';
/** @type {Readonly<SkillPickItem>} */
const MANUAL_PICK = Object.freeze({ label: '$(edit) Enter a prompt…', isManual: true });
const PLACEHOLDER_HINT = '${branch}, ${ref}, ${remote}, ${upstream}, ${base}, ${repoPath}, ${repoName}';

/**
 * Run Skill: picks a prompt template for a branch and opens a new Claude Code session with it.
 */
class SkillLauncher {
    /** @type {vscode.LogOutputChannel} */
    #log;

    /**
     * @param {vscode.LogOutputChannel} log
     */
    constructor(log) {
        this.#log = log;
    }

    /**
     * @param {RepositoryModel} model
     * @param {Branch} branch
     * @returns {Promise<void>}
     */
    async run(model, branch) {
        const branchName = displayNameOf(branch);
        const picked = await vscode.window.showQuickPick(await this.#pickItems(model), {
            title: `Run skill on ${branchName}`,
            placeHolder: 'The prompt opens in a new Claude Code session and waits for Enter',
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (picked === undefined) {
            return;
        }
        const template = picked.isManual === true ? await this.#askTemplate(branchName) : picked.template;
        if (template === undefined || template.trim() === '') {
            return;
        }
        await this.#openClaudeSession(substitutePlaceholders(template, placeholderValuesFor(model, branch)));
    }

    /**
     * @param {RepositoryModel} model
     * @returns {Promise<SkillPickItem[]>}
     */
    async #pickItems(model) {
        const configured = this.#configuredItems(model);
        const discovered = await this.#discoveredItems(model);
        /** @type {(label: string) => SkillPickItem} */
        const separator = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
        return [
            ...(configured.length > 0 ? [separator('gitBranches.skills'), ...configured] : []),
            ...(discovered.length > 0 ? [separator('Skills'), ...discovered] : []),
            separator(''),
            MANUAL_PICK,
        ];
    }

    /**
     * @param {RepositoryModel} model
     * @returns {SkillPickItem[]}
     */
    #configuredItems(model) {
        /** @type {unknown} */
        const entries = vscode.workspace.getConfiguration('gitBranches', model.repository.rootUri).get('skills', []);
        const items = [];
        for (const entry of Array.isArray(entries) ? entries : []) {
            if (typeof entry?.label !== 'string' || typeof entry?.prompt !== 'string') {
                this.#log.warn(`gitBranches.skills: no label or prompt, skipped: ${JSON.stringify(entry)}`);
                continue;
            }
            items.push({
                label: entry.label,
                description: entry.prompt,
                detail: typeof entry.description === 'string' ? entry.description : undefined,
                template: entry.prompt,
            });
        }
        return items;
    }

    /**
     * @param {RepositoryModel} model
     * @returns {Promise<SkillPickItem[]>}
     */
    async #discoveredItems(model) {
        const sources = [
            { directory: path.join(model.rootPath, '.claude', 'skills'), origin: 'project' },
            { directory: path.join(os.homedir(), '.claude', 'skills'), origin: 'user' },
        ];
        const items = [];
        for (const source of sources) {
            for (const skill of await this.#readSkills(source.directory)) {
                items.push({
                    label: `/${skill.name}`,
                    description: source.origin,
                    detail: skill.description,
                    template: DISCOVERED_SKILL_TEMPLATE.replace('{name}', skill.name),
                });
            }
        }
        return items;
    }

    /**
     * @param {string} directory
     * @returns {Promise<DiscoveredSkill[]>} user-invocable skills, by directory name
     */
    async #readSkills(directory) {
        let entries;
        try {
            entries = await fs.readdir(directory);
        } catch {
            return [];
        }
        const skills = [];
        for (const entry of entries.sort()) {
            let text;
            try {
                text = await fs.readFile(path.join(directory, entry, 'SKILL.md'), 'utf8');
            } catch {
                continue;
            }
            const frontmatter = parseSkillFrontmatter(text);
            if (frontmatter === undefined || !frontmatter.isUserInvocable) {
                continue;
            }
            skills.push({ name: frontmatter.name ?? entry, description: frontmatter.description });
        }
        return skills;
    }

    /**
     * @param {string} branchName
     * @returns {Thenable<string | undefined>}
     */
    #askTemplate(branchName) {
        return vscode.window.showInputBox({
            title: `Prompt for ${branchName}`,
            prompt: `Substituted: ${PLACEHOLDER_HINT}`,
            value: '/',
            valueSelection: [1, 1],
        });
    }

    /**
     * claude-vscode.editor.open(sessionId, prompt) is internal to Claude Code: with no session id it opens
     * a new session where Claude Code is set to open and puts the prompt into the input without sending it.
     *
     * @param {string} prompt
     * @returns {Promise<void>}
     */
    async #openClaudeSession(prompt) {
        if (vscode.extensions.getExtension(CLAUDE_EXTENSION_ID) !== undefined) {
            try {
                await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, undefined, prompt);
                return;
            } catch (error) {
                const message = typeof error === 'object' && error !== null && 'message' in error
                    ? error.message
                    : undefined;
                this.#log.error(`${CLAUDE_OPEN_COMMAND} failed: ${message ?? error}`);
            }
        }
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showWarningMessage('Claude Code did not open a session. The prompt is in the clipboard.');
    }
}

module.exports.SkillLauncher = SkillLauncher;
