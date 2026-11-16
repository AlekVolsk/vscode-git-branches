// @ts-check
'use strict';

/**
 * Взаимоисключающие категории, независимые от цвета активной ветки.
 * @param {boolean} isDefault
 * @param {Readonly<import('./branchAgeService').BranchAge> | undefined} age
 * @param {number} now
 * @param {number} days
 * @returns {'working' | 'new' | 'merged' | 'stale' | 'invalid' | 'pending'}
 */
function statisticsCategory(isDefault, age, now, days) {
    if (isDefault) {
        return 'working';
    }
    if (age === undefined || age.state === 'pending') {
        return 'pending';
    }
    if ((age.since === undefined && age.status !== 'same') || age.predatesDefault === true) {
        return 'invalid';
    }
    if (age.status === 'same' || age.status === 'empty') {
        return 'new';
    }
    if (age.isMerged) {
        return 'merged';
    }
    return isStaleBranch(isDefault, age, now, days) ? 'stale' : 'working';
}

/**
 * Устаревание независимо от статуса слияния и предупреждений истории.
 * @param {boolean} isDefault
 * @param {Readonly<import('./branchAgeService').BranchAge> | undefined} age
 * @param {number} now
 * @param {number} days
 * @returns {boolean}
 */
function isStaleBranch(isDefault, age, now, days) {
    return !isDefault && age?.state === 'resolved' && age.since !== undefined
        && now - age.since >= days * 86_400;
}

module.exports.statisticsCategory = statisticsCategory;
module.exports.isStaleBranch = isStaleBranch;
