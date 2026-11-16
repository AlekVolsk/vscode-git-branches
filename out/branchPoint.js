// @ts-check
'use strict';

/**
 * Первая общая точка first-parent-линий, без смещения входящими merge.
 *
 * @param {string} branchLog
 * @param {string} baseLog
 * @returns {{sha: string, date: number} | undefined}
 */
function findBranchPoint(branchLog, baseLog) {
    const base = new Set(baseLog.trim().split('\n').map((line) => line.split(' ')[0]));
    for (const line of branchLog.trim().split('\n')) {
        const [sha, timestamp] = line.split(' ');
        if (base.has(sha) && /^[a-f0-9]{40,64}$/.test(sha) && /^\d+$/.test(timestamp)) {
            return { sha, date: Number(timestamp) };
        }
    }
    return undefined;
}

module.exports.findBranchPoint = findBranchPoint;
