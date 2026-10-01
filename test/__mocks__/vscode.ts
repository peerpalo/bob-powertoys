// Minimal vscode mock — covers utils.ts, workspace.ts, bobExtensions.ts, and terminalConsole.ts.
// Tests that exercise vscode-dependent code paths should mock more specifically
// (e.g. override extensions.all in a beforeEach).
export const env = { appRoot: '' };

// Mutable config store — tests can write to mockConfig to control getConfiguration behaviour.
export const mockConfig: Record<string, any> = {};
export const workspace = {
  workspaceFolders: [] as any[],
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, defaultValue: T): T => {
      const full = section ? `${section}.${key}` : key;
      return full in mockConfig ? mockConfig[full] : defaultValue;
    },
  }),
};
export const Uri = {
  joinPath: (..._args: any[]) => ({ fsPath: '' }),
};
export const extensions = {
  all: [] as any[],
};
export const window = {
  terminals: [] as any[],
  activeTerminal: null as any,
  onDidStartTerminalShellExecution: (_handler: any) => ({ dispose: () => {} }),
  onDidCloseTerminal: (_handler: any) => ({ dispose: () => {} }),
};
