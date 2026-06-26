import * as vscode from 'vscode';
import * as path from 'path';

// ─── Bob-set Breakpoint Tracking ─────────────────────────────────────────────

/**
 * Maps "normalizedFile:line" to taskId of the Bob task that set the breakpoint.
 */
const breakpointOwners = new Map<string, string>();

function breakpointKey(file: string, line: number): string {
  return `${path.normalize(file)}:${line}`;
}

/**
 * Returns the taskId that owns this breakpoint, or undefined if it was not set by Bob.
 */
export function getBreakpointOwner(file: string, line: number): string | undefined {
  return breakpointOwners.get(breakpointKey(file, line));
}

function recordBreakpointOwner(file: string, line: number, taskId: string): void {
  breakpointOwners.set(breakpointKey(file, line), taskId);
}

function clearBreakpointOwner(file: string, line: number): void {
  breakpointOwners.delete(breakpointKey(file, line));
}

// ─── Tool classes ────────────────────────────────────────────────────────────

export class SetBreakpointsTool {
  static id = 'set_breakpoints';
  groups = ['edit'];
  permission = 'edit';

  getId() { return SetBreakpointsTool.id; }

  getDescription(_env?: any): string {
    return 'Set one or more breakpoints in source files. Supports conditional breakpoints. Automatically resolves relative paths against workspace folders.';
  }

  getCostEffectiveDescription(): string {
    return 'Set one or more breakpoints in source files with optional conditions';
  }

  // Shared param definition
  private static readonly PARAMS = [
    { name: 'breakpoints', required: true, type: 'array', detail: 'Array of breakpoint objects with file, line, and optional condition', description: 'Array of breakpoint objects with file, line, and optional condition', usage: '[{"file": "src/app.ts", "line": 42, "condition": "x > 10"}]' },
  ];

  // Property — read by toolToOpenAi(e).parameters
  parameters = SetBreakpointsTool.PARAMS;

  // Method — read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return SetBreakpointsTool.PARAMS;
  }

  getLabels(args: Record<string, any>) {
    const bps = args?.breakpoints ?? [];
    const count = bps.length;
    const where = count === 1 ? `${bps[0].file}:${bps[0].line}` : `${count} breakpoints`;
    return {
      displayName: `Set ${where}`,
      running: `Setting ${where}...`,
      success: `Set ${where}`,
      error: `Failed to set ${where}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { breakpoints: Array<{ file: string; line: number; condition?: string }> };
    setMetadata: (m: any) => void; 
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const taskId: string | undefined = context.env?.id;
    const breakpoints = context.parameters.breakpoints;

    if (!Array.isArray(breakpoints) || breakpoints.length === 0) {
      context.pushError('breakpoints parameter must be a non-empty array');
      return;
    }

    const results: Array<{ file: string; line: number; status: string; message: string }> = [];
    const breakpointsToAdd: vscode.SourceBreakpoint[] = [];

    for (const bp of breakpoints) {
      let uri = vscode.Uri.file(path.normalize(bp.file));

      if (!path.isAbsolute(bp.file)) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
          for (const folder of workspaceFolders) {
            const possiblePath = path.join(folder.uri.fsPath, bp.file);
            try {
              const testUri = vscode.Uri.file(possiblePath);
              await vscode.workspace.openTextDocument(testUri);
              uri = testUri;
              break;
            } catch { continue; }
          }
        }
      }

      const position = new vscode.Position(bp.line - 1, 0);
      const location = new vscode.Location(uri, position);
      breakpointsToAdd.push(new vscode.SourceBreakpoint(location, true, bp.condition));
    }

    vscode.debug.addBreakpoints(breakpointsToAdd);
    await new Promise(resolve => setTimeout(resolve, 100));

    for (let i = 0; i < breakpoints.length; i++) {
      const bp = breakpoints[i];
      const added = breakpointsToAdd[i];
      const verified = vscode.debug.breakpoints.some(
        v => v instanceof vscode.SourceBreakpoint &&
          v.location.uri.fsPath === added.location.uri.fsPath &&
          v.location.range.start.line === bp.line - 1
      );
      
      // Record ownership so the adapter can route the breakpoint-hit back to this task
      if (verified && taskId) {
        recordBreakpointOwner(added.location.uri.fsPath, bp.line, taskId);
      }
      
      results.push({
        file: bp.file,
        line: bp.line,
        status: verified ? 'success' : 'warning',
        message: verified
          ? `Set${bp.condition ? ` with condition: ${bp.condition}` : ''}`
          : 'Set but not verified — file may not exist',
      });
    }

    context.pushResult(JSON.stringify({
      summary: `${results.filter(r => r.status === 'success').length} set, ${results.filter(r => r.status === 'warning').length} warnings`,
      details: results,
    }, null, 2));
  }
}

export class RemoveBreakpointsTool {
  static id = 'remove_breakpoints';
  groups = ['edit'];
  permission = 'edit';

  getId() { return RemoveBreakpointsTool.id; }

  getDescription(_env?: any): string {
    return 'Remove one or more breakpoints from source files by file path and line number.';
  }

  getCostEffectiveDescription(): string {
    return 'Remove one or more breakpoints from source files';
  }

  // Shared param definition
  private static readonly PARAMS = [
    { name: 'breakpoints', required: true, type: 'array', detail: 'Array of breakpoint objects with file and line to remove', description: 'Array of breakpoint objects with file and line to remove', usage: '[{"file": "src/app.ts", "line": 42}]' },
  ];

  // Property — read by toolToOpenAi(e).parameters
  parameters = RemoveBreakpointsTool.PARAMS;

  // Method — read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return RemoveBreakpointsTool.PARAMS;
  }

  getLabels(args: Record<string, any>) {
    const bps = args?.breakpoints ?? [];
    const count = bps.length;
    const where = count === 1 ? `${bps[0].file}:${bps[0].line}` : `${count} breakpoints`;
    return {
      displayName: `Remove ${where}`,
      running: `Removing ${where}...`,
      success: `Removed ${where}`,
      error: `Failed to remove ${where}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { breakpoints: Array<{ file: string; line: number }> };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const breakpoints = context.parameters.breakpoints;

    if (!Array.isArray(breakpoints) || breakpoints.length === 0) {
      context.pushError('breakpoints parameter must be a non-empty array');
      return;
    }

    const results: Array<{ file: string; line: number; removed: boolean; reason?: string }> = [];
    const toRemove: vscode.Breakpoint[] = [];

    for (const bp of breakpoints) {
      const uri = vscode.Uri.file(path.normalize(bp.file));
      const matching = vscode.debug.breakpoints.filter(
        v => v instanceof vscode.SourceBreakpoint &&
          v.location.uri.fsPath === uri.fsPath &&
          v.location.range.start.line === bp.line - 1
      );

      if (matching.length > 0) {
        toRemove.push(...matching);
        // Clear ownership tracking when removed
        clearBreakpointOwner(uri.fsPath, bp.line);
        results.push({ file: bp.file, line: bp.line, removed: true });
      } else {
        results.push({ file: bp.file, line: bp.line, removed: false, reason: 'Not found' });
      }
    }

    if (toRemove.length > 0) vscode.debug.removeBreakpoints(toRemove);

    context.pushResult(JSON.stringify({
      summary: `Removed ${toRemove.length}, ${results.filter(r => !r.removed).length} not found`,
      details: results,
    }, null, 2));
  }
}

export class ListBreakpointsTool {
  static id = 'list_breakpoints';
  groups = ['read'];
  permission = 'read';

  getId() { return ListBreakpointsTool.id; }

  getDescription(_env?: any): string {
    return 'List all currently set breakpoints in the workspace, including their file locations, line numbers, conditions, and enabled status.';
  }

  getCostEffectiveDescription(): string {
    return 'List all currently set breakpoints in the workspace';
  }

  // Shared param definition
  private static readonly PARAMS: any[] = [];

  // Property — read by toolToOpenAi(e).parameters
  parameters = ListBreakpointsTool.PARAMS;

  // Method — read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return ListBreakpointsTool.PARAMS;
  }

  getLabels(_args: Record<string, any>) {
    return {
      displayName: 'List Breakpoints',
      running: 'Listing breakpoints...',
      success: 'Listed breakpoints',
      error: 'Failed to list breakpoints',
    };
  }

  async call(context: {
    env: any;
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const breakpoints = vscode.debug.breakpoints
      .filter(bp => bp instanceof vscode.SourceBreakpoint)
      .map(bp => {
        const s = bp as vscode.SourceBreakpoint;
        return {
          id: s.id,
          file: s.location.uri.fsPath,
          line: s.location.range.start.line + 1,
          condition: s.condition,
          enabled: s.enabled,
        };
      });

    context.pushResult(JSON.stringify(breakpoints, null, 2));
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register all breakpoint tools with Bob's source registry.
 */
export function registerBreakpointTools(source: any) {
  source.registerTool(new SetBreakpointsTool());
  source.registerTool(new RemoveBreakpointsTool());
  source.registerTool(new ListBreakpointsTool());
}
