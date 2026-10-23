'use strict';

const vscode = require('vscode');

const APPLY_DELAY_MS = 150;

/**
 * The input behind the filter row. The tree follows the typed text live, and closing the input keeps
 * the filter whichever way it is closed: the stable API does not tell Escape from a click into the tree.
 */
class BranchFilterPrompt {
    #tree;
    #inputBox = undefined;
    #applyTimer = undefined;

    constructor(tree) {
        this.#tree = tree;
    }

    open() {
        if (this.#inputBox !== undefined) {
            this.#inputBox.show();
            return;
        }
        const inputBox = vscode.window.createInputBox();
        inputBox.title = 'Filter branches';
        inputBox.placeholder = 'Part of a branch name; several words must all be in it';
        inputBox.value = this.#tree.filterText;
        inputBox.prompt = this.#tree.filterSummaryText;
        const subscriptions = [
            inputBox.onDidChangeValue(() => {
                clearTimeout(this.#applyTimer);
                this.#applyTimer = setTimeout(() => this.#apply(), APPLY_DELAY_MS);
            }),
            inputBox.onDidAccept(() => inputBox.hide()),
            inputBox.onDidHide(() => {
                this.#apply();
                for (const subscription of subscriptions) {
                    subscription.dispose();
                }
                inputBox.dispose();
                this.#inputBox = undefined;
            }),
        ];
        this.#inputBox = inputBox;
        inputBox.show();
    }

    dispose() {
        this.#inputBox?.dispose();
    }

    #apply() {
        clearTimeout(this.#applyTimer);
        this.#applyTimer = undefined;
        if (this.#inputBox === undefined) {
            return;
        }
        this.#tree.setFilter(this.#inputBox.value);
        this.#inputBox.prompt = this.#tree.filterSummaryText;
    }
}

module.exports = { BranchFilterPrompt };
