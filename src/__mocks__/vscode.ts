// Minimal vscode mock — only what utils.ts and workspace.ts touch at import time.
// Tests that exercise vscode-dependent code paths should mock more specifically.
export const env = { appRoot: '' };
export const workspace = { workspaceFolders: [] };
export const Uri = {
  joinPath: (..._args: any[]) => ({ fsPath: '' }),
};
