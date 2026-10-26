// @ts-check
'use strict';

const { execFile } = require('child_process');

const MAX_OUTPUT_BYTES = 67_108_864; // 64 × 1024 × 1024
const GIT_ENV = Object.freeze({
    ...process.env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
});

/**
 * @param {string} gitPath
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>} stdout; a failure rejects with the error, its `stderr` set
 */
function execGit(gitPath, cwd, args) {
    return new Promise((resolve, reject) => {
        const options = { cwd, env: GIT_ENV, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true };
        execFile(gitPath, args, options, (error, stdout, stderr) => {
            if (error === null) {
                resolve(stdout);
                return;
            }
            error.stderr = stderr;
            reject(error);
        });
    });
}

/**
 * @param {unknown} error anything thrown or rejected
 * @returns {string} the trimmed `stderr` of a git failure, otherwise the message or the value itself
 */
function describeGitError(error) {
    const details = typeof error === 'object' && error !== null ? error : {};
    const stderr = 'stderr' in details && typeof details.stderr === 'string' ? details.stderr.trim() : '';
    const message = 'message' in details ? details.message : undefined;
    return stderr !== '' ? stderr : String(message ?? error);
}

module.exports.execGit = execGit;
module.exports.describeGitError = describeGitError;
