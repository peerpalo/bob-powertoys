import * as vscode from 'vscode';
import * as path from 'path';
import { parseJsonParameter } from './utils.js';

// ─── Bob-set Breakpoint Tracking ─────────────────────────────────────────────

/**
 * Set of breakpoints that were set by Bob (via set_breakpoints tool)
 * Format: "file:line" (normalized file path)
 */
const bobSetBreakpoints = new Set<string>();

/**
 * Check if a breakpoint was set by Bob
 */
export function isBobSetBreakpoint(file: string, line: number): boolean {
  const normalizedFile = path.normalize(file);
  const key = `${normalizedFile}:${line}`;
  return bobSetBreakpoints.has(key);
}

/**
 * Mark a breakpoint as set by Bob
 */
function markAsBobSet(file: string, line: number): void {
  const normalizedFile = path.normalize(file);
  const key = `${normalizedFile}:${line}`;
  bobSetBreakpoints.add(key);
}

/**
 * Unmark a breakpoint as set by Bob
 */
function unmarkAsBobSet(file: string, line: number): void {
  const normalizedFile = path.normalize(file);
  const key = `${normalizedFile}:${line}`;
  bobSetBreakpoints.delete(key);
}

// ─── Tool classes ────────────────────────────────────────────────────────────

export class SetBreakpointsTool {
  static id = 'set_breakpoints';
  groups = ['edit'];
  parameters = [
    {
      name: 'breakpoints',
      required: true,
      type: 'array',
      description: 'Array of breakpoint objects with file, line, and optional condition',
      usage: '[{"file": "src/app.ts", "line": 42, "condition": "x > 10"}]'
    }
  ];

  getId() { return SetBreakpointsTool.id; }

  getDescription(_options?: any): string {
    return `## set_breakpoints
Description: Set one or more breakpoints in source files. Supports conditional breakpoints. Automatically resolves relative paths against workspace folders.

Parameters:
- breakpoints: (required) array. List of breakpoint objects, each containing:
  - file: (required) string. File path (absolute or relative to workspace)
  - line: (required) number. Line number (1-based)
  - condition: (optional) string. Conditional expression for the breakpoint

Usage:
<set_breakpoints>
<breakpoints>[{"file": "src/app.ts", "line": 42}, {"file": "src/utils.ts", "line": 15, "condition": "count > 100"}]</breakpoints>
</set_breakpoints>`;
  }

  getCostEffectiveDescription(): string {
    return 'Set one or more breakpoints in source files with optional conditions';
  }

  toolUseDescription(params: any): string {
    let breakpoints: any;
    try {
      breakpoints = parseJsonParameter(params?.breakpoints, 'breakpoints');
    } catch {
      breakpoints = params?.breakpoints;
    }
    const count = Array.isArray(breakpoints) ? breakpoints.length : 0;
    return `Setting ${count} breakpoint${count !== 1 ? 's' : ''}...`;
  }

  async call(context: {
    parameters: { breakpoints: Array<{ file: string; line: number; condition?: string }> };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    // Parse breakpoints (Bob sends arrays as JSON strings)
    let breakpoints: Array<{ file: string; line: number; condition?: string }>;
    try {
      breakpoints = parseJsonParameter(context.parameters.breakpoints, 'breakpoints');
    } catch (error) {
      context.pushError(error instanceof Error ? error.message : String(error));
      return;
    }

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
      
      // Mark as Bob-set if successfully added
      if (verified) {
        markAsBobSet(added.location.uri.fsPath, bp.line);
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
  parameters = [
    {
      name: 'breakpoints',
      required: true,
      type: 'array',
      description: 'Array of breakpoint objects with file and line to remove',
      usage: '[{"file": "src/app.ts", "line": 42}]'
    }
  ];

  getId() { return RemoveBreakpointsTool.id; }

  getDescription(_options?: any): string {
    return `## remove_breakpoints
Description: Remove one or more breakpoints from source files by file path and line number.

Parameters:
- breakpoints: (required) array. List of breakpoint objects to remove, each containing:
  - file: (required) string. File path
  - line: (required) number. Line number (1-based)

Usage:
<remove_breakpoints>
<breakpoints>[{"file": "src/app.ts", "line": 42}, {"file": "src/utils.ts", "line": 15}]</breakpoints>
</remove_breakpoints>`;
  }

  getCostEffectiveDescription(): string {
    return 'Remove one or more breakpoints from source files';
  }

  toolUseDescription(params: any): string {
    let breakpoints: any;
    try {
      breakpoints = parseJsonParameter(params?.breakpoints, 'breakpoints');
    } catch {
      breakpoints = params?.breakpoints;
    }
    const count = Array.isArray(breakpoints) ? breakpoints.length : 0;
    return `Removing ${count} breakpoint${count !== 1 ? 's' : ''}...`;
  }

  async call(context: {
    parameters: { breakpoints: Array<{ file: string; line: number }> };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    // Parse breakpoints (Bob sends arrays as JSON strings)
    let breakpoints: Array<{ file: string; line: number }>;
    try {
      breakpoints = parseJsonParameter(context.parameters.breakpoints, 'breakpoints');
    } catch (error) {
      context.pushError(error instanceof Error ? error.message : String(error));
      return;
    }

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
        // Unmark as Bob-set when removed
        unmarkAsBobSet(uri.fsPath, bp.line);
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
  parameters = [];

  getId() { return ListBreakpointsTool.id; }

  getDescription(_options?: any): string {
    return `## list_breakpoints
Description: List all currently set breakpoints in the workspace, including their file locations, line numbers, conditions, and enabled status.

Parameters: None

Usage:
<list_breakpoints>
</list_breakpoints>`;
  }

  getCostEffectiveDescription(): string {
    return 'List all currently set breakpoints in the workspace';
  }

  toolUseDescription(): string {
    return 'Listing breakpoints...';
  }

  async call(context: {
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
