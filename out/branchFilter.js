// @ts-check
'use strict';

/**
 * @typedef {(name: string) => Array<[number, number]> | undefined} NameMatcher
 */

/**
 * A branch name cannot contain whitespace, so whitespace in a query only separates words.
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseFilterWords(text) {
    return text.split(/\s+/).filter((word) => word !== '');
}

/**
 * Case-insensitive: a name matches when it contains every word.
 *
 * @param {string[]} words
 * @returns {NameMatcher | undefined} `undefined` for no words;
 *     the matcher returns the merged ranges of every occurrence, or `undefined` for a name that does not match
 */
function createNameMatcher(words) {
    if (words.length === 0) {
        return undefined;
    }
    const patterns = words.map((word) => new RegExp(escapeRegExp(word), 'giu'));
    return (name) => {
        const ranges = [];
        for (const pattern of patterns) {
            /** @type {Array<[number, number]>} */
            const found = [...name.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);
            if (found.length === 0) {
                return undefined;
            }
            ranges.push(...found);
        }
        return mergeRanges(ranges);
    };
}

/**
 * @param {Array<[number, number]>} ranges
 * @returns {Array<[number, number]>} sorted, overlapping and touching ranges joined
 */
function mergeRanges(ranges) {
    /** @type {Array<[number, number]>} */
    const merged = [];
    for (const [start, end] of [...ranges].sort((left, right) => left[0] - right[0])) {
        const last = merged[merged.length - 1];
        if (last !== undefined && start <= last[1]) {
            last[1] = Math.max(last[1], end);
            continue;
        }
        merged.push([start, end]);
    }
    return merged;
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports.parseFilterWords = parseFilterWords;
module.exports.createNameMatcher = createNameMatcher;
