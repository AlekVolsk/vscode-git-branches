// @ts-check
'use strict';

const { shortenRefName } = require('./branchRefs');

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const FRONTMATTER_FIELD = /^([A-Za-z][\w-]*):[ \t]*(.*)$/;
const BLOCK_SCALAR_MARKERS = new Set(['>', '|', '>-', '|-', '>+', '|+']);
const PLACEHOLDER = /\$\{(\w+)\}/g;

/**
 * @typedef {import('./branchRefs').Branch} Branch
 */

/**
 * @typedef {object} SkillFrontmatter
 * @property {string | undefined} name
 * @property {string} description empty for none or a block scalar
 * @property {boolean} isUserInvocable
 */

/**
 * @typedef {object} PlaceholderRepository
 * @property {Branch | undefined} base
 * @property {string} rootPath
 * @property {string} name
 */

/**
 * @typedef {object} PlaceholderValues
 * @property {string} branch
 * @property {string} ref
 * @property {string} remote
 * @property {string} upstream
 * @property {string} base
 * @property {string} repoPath
 * @property {string} repoName
 */

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
    const isQuoted = value.length >= 2
        && (value.startsWith('"') || value.startsWith('\''))
        && value.endsWith(value[0]);
    return isQuoted ? value.slice(1, -1) : value;
}

/**
 * @param {string} text contents of `SKILL.md`
 * @returns {SkillFrontmatter | undefined} `undefined` without frontmatter
 */
function parseSkillFrontmatter(text) {
    const frontmatter = FRONTMATTER.exec(text);
    if (frontmatter === null) {
        return undefined;
    }
    /** @type {Map<string, string>} */
    const fields = new Map();
    for (const line of frontmatter[1].split(/\r?\n/)) {
        const field = FRONTMATTER_FIELD.exec(line);
        if (field !== null) {
            fields.set(field[1], unquote(field[2].trim()));
        }
    }
    const description = fields.get('description') ?? '';
    return {
        name: fields.get('name'),
        description: BLOCK_SCALAR_MARKERS.has(description) ? '' : description,
        isUserInvocable: fields.get('user-invocable') !== 'false',
    };
}

/**
 * @param {PlaceholderRepository} model
 * @param {Branch} branch
 * @returns {PlaceholderValues}
 */
function placeholderValuesFor(model, branch) {
    const isRemote = branch.kind === 'remote';
    return {
        branch: branch.name,
        ref: isRemote ? `${branch.remoteName}/${branch.name}` : branch.name,
        remote: isRemote ? branch.remoteName : (branch.upstreamRemote ?? ''),
        upstream: isRemote ? '' : (branch.upstream ?? ''),
        base: model.base === undefined ? '' : shortenRefName(model.base.refname),
        repoPath: model.rootPath,
        repoName: model.name,
    };
}

/**
 * @param {string} template
 * @param {Readonly<Record<string, string>>} values
 * @returns {string} the template with every known `${key}` replaced; unknown ones stay
 */
function substitutePlaceholders(template, values) {
    return template.replace(PLACEHOLDER, (placeholder, key) => {
        return Object.hasOwn(values, key) ? values[key] : placeholder;
    });
}

module.exports.parseSkillFrontmatter = parseSkillFrontmatter;
module.exports.placeholderValuesFor = placeholderValuesFor;
module.exports.substitutePlaceholders = substitutePlaceholders;
