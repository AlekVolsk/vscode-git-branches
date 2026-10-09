'use strict';

const FIELD_SEPARATOR = '\x1f';
const FIELDS_BEFORE_SUBJECT = 9;
const LOCAL_PREFIX = 'refs/heads/';
const REMOTE_PREFIX = 'refs/remotes/';
const REFLOG_CREATION_PREFIX = 'branch: Created from';
const FALLBACK_MAIN_NAMES = Object.freeze(['master', 'main']);
const FALLBACK_BASE_REFS = Object.freeze(FALLBACK_MAIN_NAMES.map((name) => `${LOCAL_PREFIX}${name}`));
const PRIMARY_REMOTE = 'origin';

const FOR_EACH_REF_FORMAT = [
    '%(refname)',
    '%(objectname)',
    '%(HEAD)',
    '%(symref)',
    '%(upstream)',
    '%(upstream:track,nobracket)',
    '%(worktreepath)',
    '%(committerdate:unix)',
    '%(authorname)',
    '%(subject)',
].join('%1f');

const REFLOG_FORMAT = '%gd%x1f%gs';
const BRANCH_LINE_FORMAT = '%H%x1f%at';

function parseTrack(track) {
    if (track === 'gone') {
        return { ahead: 0, behind: 0, isUpstreamGone: true };
    }
    const ahead = /ahead (\d+)/.exec(track);
    const behind = /behind (\d+)/.exec(track);
    return {
        ahead: ahead === null ? 0 : Number(ahead[1]),
        behind: behind === null ? 0 : Number(behind[1]),
        isUpstreamGone: false,
    };
}

function findRemoteName(remoteRefPath, remoteNamesLongestFirst) {
    const known = remoteNamesLongestFirst.find((name) => remoteRefPath.startsWith(`${name}/`));
    if (known !== undefined) {
        return known;
    }
    const slashIndex = remoteRefPath.indexOf('/');
    return slashIndex === -1 ? undefined : remoteRefPath.slice(0, slashIndex);
}

function parseUpstream(upstreamRef, remoteNamesLongestFirst) {
    if (upstreamRef === '') {
        return { upstream: undefined, upstreamRemote: undefined, upstreamBranch: undefined };
    }
    if (upstreamRef.startsWith(LOCAL_PREFIX)) {
        const localName = upstreamRef.slice(LOCAL_PREFIX.length);
        return { upstream: localName, upstreamRemote: undefined, upstreamBranch: localName };
    }
    const remoteRefPath = upstreamRef.slice(REMOTE_PREFIX.length);
    const upstreamRemote = findRemoteName(remoteRefPath, remoteNamesLongestFirst);
    return {
        upstream: remoteRefPath,
        upstreamRemote,
        upstreamBranch: upstreamRemote === undefined ? remoteRefPath : remoteRefPath.slice(upstreamRemote.length + 1),
    };
}

function parseForEachRef(output, remoteNames) {
    const remoteNamesLongestFirst = [...remoteNames].sort((left, right) => right.length - left.length);
    const local = [];
    const remotes = new Map(remoteNames.map((name) => [name, []]));
    const remoteHeads = new Map();

    for (const line of output.split('\n')) {
        if (line === '') {
            continue;
        }
        const fields = line.split(FIELD_SEPARATOR);
        const [refname, sha, headMark, symref, upstreamRef, track, worktreePath, committerDate, author] = fields;
        const lastCommit = {
            sha,
            committerDate: Number(committerDate),
            author,
            subject: fields.slice(FIELDS_BEFORE_SUBJECT).join(FIELD_SEPARATOR),
        };

        if (refname.startsWith(LOCAL_PREFIX)) {
            const isHead = headMark === '*';
            local.push({
                kind: 'local',
                refname,
                name: refname.slice(LOCAL_PREFIX.length),
                ...lastCommit,
                isHead,
                isInOtherWorktree: worktreePath !== '' && !isHead,
                worktreePath: worktreePath === '' ? undefined : worktreePath,
                ...parseUpstream(upstreamRef, remoteNamesLongestFirst),
                ...parseTrack(track),
            });
            continue;
        }

        if (!refname.startsWith(REMOTE_PREFIX)) {
            continue;
        }
        const remoteRefPath = refname.slice(REMOTE_PREFIX.length);
        const remoteName = findRemoteName(remoteRefPath, remoteNamesLongestFirst);
        if (remoteName === undefined) {
            continue;
        }
        if (symref !== '') {
            remoteHeads.set(remoteName, symref);
            continue;
        }
        if (!remotes.has(remoteName)) {
            remotes.set(remoteName, []);
        }
        remotes.get(remoteName).push({
            kind: 'remote',
            refname,
            name: remoteRefPath.slice(remoteName.length + 1),
            remoteName,
            ...lastCommit,
        });
    }

    return { local, remotes, remoteHeads };
}

function sortBranches(branches, sortOrder) {
    const byName = (left, right) => left.name.localeCompare(right.name, undefined, { numeric: true });
    if (sortOrder === 'committerdate') {
        return [...branches].sort((left, right) => right.committerDate - left.committerDate || byName(left, right));
    }
    return [...branches].sort(byName);
}

function resolveBaseBranch(refs, configuredBase) {
    const branchByRefname = new Map();
    for (const branch of [...refs.local, ...[...refs.remotes.values()].flat()]) {
        branchByRefname.set(branch.refname, branch);
    }
    const candidates = configuredBase !== ''
        ? [configuredBase, `${LOCAL_PREFIX}${configuredBase}`, `${REMOTE_PREFIX}${configuredBase}`]
        : [refs.remoteHeads.get(PRIMARY_REMOTE), ...refs.remoteHeads.values(), ...FALLBACK_BASE_REFS];
    const baseRef = candidates.find((candidate) => candidate !== undefined && branchByRefname.has(candidate));
    return baseRef === undefined ? undefined : branchByRefname.get(baseRef);
}

function resolveMainBranchName(refs) {
    const originHead = refs.remoteHeads.get(PRIMARY_REMOTE);
    const remoteHeads = originHead === undefined
        ? [...refs.remoteHeads]
        : [[PRIMARY_REMOTE, originHead], ...refs.remoteHeads];
    for (const [remoteName, target] of remoteHeads) {
        const prefix = `${REMOTE_PREFIX}${remoteName}/`;
        if (target.startsWith(prefix)) {
            return target.slice(prefix.length);
        }
    }
    const branchNames = new Set([...refs.local, ...[...refs.remotes.values()].flat()].map((branch) => branch.name));
    return FALLBACK_MAIN_NAMES.find((name) => branchNames.has(name));
}

/**
 * Walks the first-parent log of a branch, newest first, to the first commit that lies on the
 * first-parent line of the base: the commit just before it is the first one of the branch's own line.
 */
function parseBranchLine(logOutput, baseLineShas) {
    const commits = logOutput.split('\n').filter((line) => line !== '').map((line) => {
        const [sha, authorDate] = line.split(FIELD_SEPARATOR);
        return { sha, authorDate: Number(authorDate) };
    });
    const forkIndex = commits.findIndex((commit) => baseLineShas.has(commit.sha));
    return {
        tipDate: commits.length === 0 ? undefined : commits[0].authorDate,
        lineStartDate: forkIndex > 0 ? commits[forkIndex - 1].authorDate : undefined,
    };
}

function parseOldestTimestamp(logOutput) {
    const firstLine = logOutput.split('\n', 1)[0].trim();
    return firstLine === '' ? undefined : Number(firstLine);
}

function parseReflogCreation(reflogOutput) {
    const entries = reflogOutput.split('\n').filter((line) => line !== '');
    if (entries.length === 0) {
        return undefined;
    }
    const [selector, subject = ''] = entries[entries.length - 1].split(FIELD_SEPARATOR);
    if (!subject.startsWith(REFLOG_CREATION_PREFIX)) {
        return undefined;
    }
    const timestamp = /@\{(\d+)\}$/.exec(selector);
    return timestamp === null ? undefined : Number(timestamp[1]);
}

function describeUpstream(branch) {
    if (branch.upstream === undefined) {
        return 'no upstream';
    }
    if (branch.isUpstreamGone) {
        return `${branch.upstream} gone`;
    }
    const counts = [];
    if (branch.ahead > 0) {
        counts.push(`↑${branch.ahead}`);
    }
    if (branch.behind > 0) {
        counts.push(`↓${branch.behind}`);
    }
    const isSameName = branch.upstreamRemote !== undefined && branch.upstreamBranch === branch.name;
    const target = isSameName ? branch.upstreamRemote : branch.upstream;
    return [counts.join(' '), target].filter((part) => part !== '').join(' · ');
}

function addCalendarMonths(date, count) {
    const result = new Date(date.getTime());
    const dayOfMonth = result.getDate();
    result.setDate(1);
    result.setMonth(result.getMonth() + count);
    const daysInMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(dayOfMonth, daysInMonth));
    return result;
}

function isOlderThanMonths(sinceSeconds, nowSeconds, months) {
    return addCalendarMonths(new Date(sinceSeconds * 1_000), months) <= new Date(nowSeconds * 1_000);
}

/**
 * Calendar age: hours under a day, days under a month, months and days under a year, then years and months.
 */
function formatAge(sinceSeconds, nowSeconds) {
    const hours = Math.floor(Math.max(nowSeconds - sinceSeconds, 0) / 3_600);
    if (hours < 24) {
        return `${hours}h`;
    }
    const since = new Date(sinceSeconds * 1_000);
    const now = new Date(nowSeconds * 1_000);
    let months = (now.getFullYear() - since.getFullYear()) * 12 + now.getMonth() - since.getMonth();
    if (addCalendarMonths(since, months) > now) {
        months -= 1;
    }
    const days = Math.floor((now - addCalendarMonths(since, months)) / 86_400_000);
    if (months === 0) {
        return `${days}d`;
    }
    if (months < 12) {
        return days === 0 ? `${months}mo` : `${months}mo ${days}d`;
    }
    const years = Math.floor(months / 12);
    const restMonths = months % 12;
    return restMonths === 0 ? `${years}y` : `${years}y ${restMonths}mo`;
}

function formatDate(unixSeconds) {
    const date = new Date(unixSeconds * 1_000);
    const pad = (value) => String(value).padStart(2, '0');
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortSha(sha) {
    return sha.slice(0, 8);
}

function shortenRefName(refname) {
    for (const prefix of [LOCAL_PREFIX, REMOTE_PREFIX]) {
        if (refname.startsWith(prefix)) {
            return refname.slice(prefix.length);
        }
    }
    return refname;
}

function displayNameOf(branch) {
    return branch.kind === 'remote' ? `${branch.remoteName}/${branch.name}` : branch.name;
}

module.exports = {
    FOR_EACH_REF_FORMAT,
    REFLOG_FORMAT,
    BRANCH_LINE_FORMAT,
    parseBranchLine,
    parseForEachRef,
    sortBranches,
    resolveBaseBranch,
    resolveMainBranchName,
    parseOldestTimestamp,
    parseReflogCreation,
    describeUpstream,
    formatAge,
    isOlderThanMonths,
    formatDate,
    shortSha,
    shortenRefName,
    displayNameOf,
};
