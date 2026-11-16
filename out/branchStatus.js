// @ts-check
'use strict';

/**
 * Состояние по графу: вхождение в first-parent-линию базы не доказывает слияние.
 * @param {boolean} sameTip
 * @param {boolean} hasOwn
 * @param {boolean} baseHasOwn
 * @param {boolean} onBaseLine
 * @returns {'same' | 'empty' | 'merged' | 'synced' | 'diverged'}
 */
function classifyBranch(sameTip, hasOwn, baseHasOwn, onBaseLine) {
    if (sameTip) {
        return 'same';
    }
    if (!hasOwn) {
        return onBaseLine ? 'empty' : 'merged';
    }
    return baseHasOwn ? 'diverged' : 'synced';
}

module.exports.classifyBranch = classifyBranch;
