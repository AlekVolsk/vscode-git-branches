'use strict';

const vscode = require('vscode');

const BRANCH_URI_SCHEME = 'git-branches';
const COLOR_ID_BY_KIND = new Map([
    ['local', 'gitBranches.localBranchForeground'],
    ['remote', 'gitBranches.remoteBranchForeground'],
    ['current', 'gitBranches.currentBranchForeground'],
    ['stale', 'gitBranches.staleBranchForeground'],
    ['merged', 'gitBranches.mergedBranchForeground'],
]);

/**
 * Tree item labels get a color only through a file decoration, so branch items carry
 * a git-branches:// resource URI whose authority is the branch kind.
 */
class BranchDecorationProvider {
    static colorIdFor(kind) {
        return COLOR_ID_BY_KIND.get(kind);
    }

    static uriFor(kind, nodeId) {
        return vscode.Uri.from({ scheme: BRANCH_URI_SCHEME, authority: kind, path: `/${encodeURIComponent(nodeId)}` });
    }

    provideFileDecoration(uri) {
        if (uri.scheme !== BRANCH_URI_SCHEME) {
            return undefined;
        }
        const colorId = COLOR_ID_BY_KIND.get(uri.authority);
        if (colorId === undefined) {
            return undefined;
        }
        return new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor(colorId));
    }
}

module.exports = { BranchDecorationProvider };
