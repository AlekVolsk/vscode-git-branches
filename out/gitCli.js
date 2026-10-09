'use strict';

const { execFile } = require('child_process');

const MAX_OUTPUT_BYTES = 67_108_864; // 64 × 1024 × 1024
const GIT_ENV = Object.freeze({
    ...process.env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
});

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

function describeGitError(error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    return stderr !== '' ? stderr : String(error?.message ?? error);
}

module.exports = { execGit, describeGitError };
