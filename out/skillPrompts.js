'use strict';

const { shortenRefName } = require('./branchRefs');

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const FRONTMATTER_FIELD = /^([A-Za-z][\w-]*):[ \t]*(.*)$/;
const BLOCK_SCALAR_MARKERS = new Set(['>', '|', '>-', '|-', '>+', '|+']);
const PLACEHOLDER = /\$\{(\w+)\}/g;

function unquote(value) {
    const isQuoted = value.length >= 2
        && (value.startsWith('"') || value.startsWith('\''))
        && value.endsWith(value[0]);
    return isQuoted ? value.slice(1, -1) : value;
}

function parseSkillFrontmatter(text) {
    const frontmatter = FRONTMATTER.exec(text);
    if (frontmatter === null) {
        return undefined;
    }
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

function substitutePlaceholders(template, values) {
    return template.replace(PLACEHOLDER, (placeholder, key) => {
        return Object.hasOwn(values, key) ? values[key] : placeholder;
    });
}

module.exports = { parseSkillFrontmatter, placeholderValuesFor, substitutePlaceholders };
