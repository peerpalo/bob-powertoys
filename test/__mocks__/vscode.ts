// Minimal vscode mock — covers utils.ts, workspace.ts, and bobExtensions.ts.
// Tests that exercise vscode-dependent code paths should mock more specifically
// (e.g. override extensions.all in a beforeEach).
export const env = { appRoot: '' };
export const workspace = { workspaceFolders: [] };
export const Uri = {
  joinPath: (..._args: any[]) => ({ fsPath: '' }),
};
export const extensions = {
  all: [] as any[],
};
