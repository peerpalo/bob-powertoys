import * as vscode from 'vscode';
import { paramsToSchema } from '../utils.js';

const terminalOutputLog = new Map<vscode.Terminal, string[]>();
const MAX_TERMINAL_OUTPUT_LINES = 1000;
// Buffer is intentionally larger than the output window so startLine pagination
// can reach earlier history beyond what a single call returns.
const MAX_TERMINAL_BUFFER_LINES = 5000;

function stripAnsi(str: string): string {
  // OSC sequences (\x1B]...ST or BEL), then all other ESC sequences
  return str
    .replace(/\x1B\][^\x1B\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]|\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * Register terminal output capture. Must be called from extension activate().
 */
export function registerTerminalCapture(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution(event => {
      const terminal = event.terminal;
      if (!terminalOutputLog.has(terminal)) {
        terminalOutputLog.set(terminal, []);
      }

      // Each shell execution appends to the same terminal's log. Concurrent
      // executions (e.g. rapid Ctrl+C + new command) are accepted without
      // synchronisation — VS Code serialises shell integration in practice.
      void (async () => {
        try {
          for await (const chunk of event.execution.read()) {
            const log = terminalOutputLog.get(terminal);
            if (log) {
              // Chunks are arbitrary PTY blobs — split into actual lines so that
              // startLine, lines, totalLines, and outputLines are line-accurate.
              // split('\n') on "a\nb\n" gives ["a","b",""] — filter the trailing
              // empty fragment so we don't store a spurious blank line.
              const stripped = stripAnsi(chunk);
              const parts = stripped.split('\n');
              if (parts[parts.length - 1] === '') parts.pop();
              for (const part of parts) {
                log.push(part + '\n');
              }
              // Drop oldest 10% in a batch to amortise the cost of overflow.
              if (log.length > MAX_TERMINAL_BUFFER_LINES) {
                log.splice(0, Math.ceil(MAX_TERMINAL_BUFFER_LINES * 0.1));
              }
            }
          }
        } catch {
          // Ignore errors from shell execution stream
        }
      })();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(terminal => {
      terminalOutputLog.delete(terminal);
    })
  );
}

// ─── Tool classes ────────────────────────────────────────────────────────────

export class ListTerminalsTool {
  static id = 'list_terminals';
  groups = ['read'];
  permission = 'read';
 
  getId() { return ListTerminalsTool.id; }
 
  getDescription(_env?: any): string {
    return 'List all open terminals with their names, active status, exit status, and output capture information.';
  }
 
  getCostEffectiveDescription(): string {
    return 'List all open terminals with their status and output information';
  }
 
  // Shared param definition
  private static readonly PARAMS: any[] = [];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(ListTerminalsTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return ListTerminalsTool.PARAMS;
  }
 
  getLabels(_args: Record<string, any>) {
    return {
      displayName: 'List Terminals',
      running: 'Listing terminals...',
      success: 'Listed terminals',
      error: 'Failed to list terminals',
    };
  }
 
  async call(context: {
    env: any;
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const terminals = vscode.window.terminals;
    const activeTerminal = vscode.window.activeTerminal;
 
    const terminalList = terminals.map(t => ({
      name: t.name,
      isActive: t === activeTerminal,
      exitStatus: t.exitStatus,
      hasOutput: terminalOutputLog.has(t),
      outputLines: terminalOutputLog.get(t)?.length ?? 0,
    }));
 
    context.pushResult(JSON.stringify(terminalList, null, 2));
  }
}
 
export class GetTerminalOutputTool {
  static id = 'get_terminal_output';
  groups = ['read'];
  permission = 'read';
 
  getId() { return GetTerminalOutputTool.id; }
 
  getDescription(_env?: any): string {
    return `Get captured output from a terminal. Output is captured automatically via shell integration. Use \`lines\` to return the last N lines (default: 50, max: ${MAX_TERMINAL_OUTPUT_LINES}), or \`startLine\` to paginate forward — call \`list_terminals\` first to get \`outputLines\` for the full buffer size. If output was truncated, the response includes \`truncated: true\`.`;
  }
 
  getCostEffectiveDescription(): string {
    return 'Get captured output from a terminal';
  }
 
  // Shared param definition
  private static readonly PARAMS = [
    { name: 'terminalName', type: 'string', detail: 'Name of the terminal to get output from (defaults to active terminal)', description: 'Name of the terminal to get output from (defaults to active terminal)', required: false, usage: 'bash' },
    { name: 'lines', type: 'number', detail: `Max number of lines to return (default: 50, max: ${MAX_TERMINAL_OUTPUT_LINES}). Returns the last N lines. Takes priority over startLine when both are provided.`, description: `Max number of lines to return (default: 50, max: ${MAX_TERMINAL_OUTPUT_LINES}). Returns the last N lines. Takes priority over startLine when both are provided.`, required: false, usage: '50' },
    { name: 'startLine', type: 'number', detail: '0-based line index to start reading from. Use list_terminals to get total outputLines. Ignored when lines is also provided.', description: '0-based line index to start reading from. Ignored when lines is also provided.', required: false, usage: '0' },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(GetTerminalOutputTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return GetTerminalOutputTool.PARAMS;
  }
 
  getLabels(args: Record<string, any>) {
    const name = args?.terminalName;
    return {
      displayName: name ? `Get Output: ${name}` : 'Get Terminal Output',
      running: name ? `Getting output from terminal: ${name}` : 'Getting output from active terminal',
      success: 'Got terminal output',
      error: 'Failed to get terminal output',
    };
  }
 
  async call(context: {
    env: any;
    parameters: { terminalName?: string; lines?: number; startLine?: number };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { terminalName, lines, startLine } = context.parameters;
 
    const terminal = terminalName
      ? vscode.window.terminals.find(t => t.name === terminalName)
      : vscode.window.activeTerminal;
 
    if (!terminal) {
      context.pushError(JSON.stringify({
        error: terminalName ? `Terminal "${terminalName}" not found` : 'No active terminal',
      }, null, 2));
      return;
    }
 
    const output = terminalOutputLog.get(terminal) ?? [];
 
    if (output.length === 0) {
      context.pushResult(JSON.stringify({
        terminalName: terminal.name,
        totalLines: 0,
        output: '',
        message: 'No output captured. Output is only captured after extension activation and requires shell integration.',
      }, null, 2));
      return;
    }

    // Determine which slice of lines to use, capped at MAX_TERMINAL_OUTPUT_LINES
    let slice: string[];
    let isTruncated = false;
    if (lines !== undefined) {
      // tail-N mode: last N lines, capped. Takes priority over startLine.
      const n = Math.min(lines, MAX_TERMINAL_OUTPUT_LINES);
      slice = output.slice(Math.max(0, output.length - n));
      isTruncated = lines > MAX_TERMINAL_OUTPUT_LINES;
    } else if (startLine !== undefined) {
      // paginate-from mode: start at offset, take up to MAX_TERMINAL_OUTPUT_LINES
      const from = Math.max(0, startLine);
      const n = MAX_TERMINAL_OUTPUT_LINES;
      slice = output.slice(from, from + n);
      isTruncated = (output.length - from) > n;
    } else {
      // default: last 50 lines
      slice = output.slice(Math.max(0, output.length - 50));
    }

    context.pushResult(JSON.stringify({
      terminalName: terminal.name,
      totalLines: output.length,
      returnedLines: slice.length,
      ...(isTruncated && { truncated: true }),
      output: slice.join(''),
    }, null, 2));
  }
}
 
export class SearchTerminalOutputTool {
  static id = 'search_terminal_output';
  groups = ['read'];
  permission = 'read';
 
  getId() { return SearchTerminalOutputTool.id; }
 
  getDescription(_env?: any): string {
    return `Search terminal output using a regular expression pattern. Returns matching lines with their content (max: ${MAX_TERMINAL_OUTPUT_LINES} matching lines). If results were truncated, the response includes \`truncated: true\`.`;
  }
 
  getCostEffectiveDescription(): string {
    return 'Search terminal output using a regular expression pattern';
  }
 
  // Shared param definition
  private static readonly PARAMS = [
    { name: 'query', type: 'string', detail: 'Regular expression pattern to search for in terminal output', description: 'Regular expression pattern to search for in terminal output', required: true, usage: 'error|warning' },
    { name: 'terminalName', type: 'string', detail: 'Name of the terminal to search (defaults to active terminal)', description: 'Name of the terminal to search (defaults to active terminal)', required: false, usage: 'bash' },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(SearchTerminalOutputTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return SearchTerminalOutputTool.PARAMS;
  }
 
  getLabels(args: Record<string, any>) {
    return {
      displayName: 'Search Terminal Output',
      running: `Searching for: ${args?.query ?? ''}`,
      success: 'Search complete',
      error: 'Search failed',
    };
  }
 
  async call(context: {
    env: any;
    parameters: { query: string; terminalName?: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { query, terminalName } = context.parameters;
 
    const terminal = terminalName
      ? vscode.window.terminals.find(t => t.name === terminalName)
      : vscode.window.activeTerminal;
 
    if (!terminal) {
      context.pushError(JSON.stringify({
        error: terminalName ? `Terminal "${terminalName}" not found` : 'No active terminal',
      }, null, 2));
      return;
    }
 
    const output = terminalOutputLog.get(terminal) ?? [];
 
    if (output.length === 0) {
      context.pushResult(JSON.stringify({
        terminalName: terminal.name,
        query,
        matchedOutput: '',
        message: 'No output captured. Output is only captured after extension activation and requires shell integration.',
      }, null, 2));
      return;
    }
 
    const regex = new RegExp(query, 'i');
    const matches: string[] = [];
    let truncated = false;

    for (let i = 0; i < output.length; i++) {
      if (regex.test(output[i])) {
        if (matches.length >= MAX_TERMINAL_OUTPUT_LINES) {
          truncated = true;
          break;
        }
        matches.push(output[i]);
      }
    }

    context.pushResult(JSON.stringify({
      terminalName: terminal.name,
      query,
      totalLines: output.length,
      matchedLines: matches.length,
      ...(truncated && { truncated: true }),
      matchedOutput: matches.join(''),
    }, null, 2));
  }
 
  // Optional: reject an invalid regex before call() runs
  async validate(context: { env: any; parameters: { query: string } }): Promise<string | undefined> {
    try {
      new RegExp(context.parameters.query);
      return undefined;
    } catch (error) {
      return `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
 
export class FocusTerminalTool {
  static id = 'focus_terminal';
  groups = ['edit'];
  permission = 'edit';
 
  getId() { return FocusTerminalTool.id; }
 
  getDescription(_env?: any): string {
    return 'Bring a terminal into focus in the VS Code UI. Makes the terminal visible and active.';
  }
 
  getCostEffectiveDescription(): string {
    return 'Bring a terminal into focus in the VS Code UI';
  }
 
  // Shared param definition
  private static readonly PARAMS = [
    { name: 'terminalName', type: 'string', detail: 'Name of the terminal to focus (defaults to active terminal)', description: 'Name of the terminal to focus (defaults to active terminal)', required: false, usage: 'bash' },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(FocusTerminalTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return FocusTerminalTool.PARAMS;
  }
 
  getLabels(args: Record<string, any>) {
    const name = args?.terminalName;
    return {
      displayName: name ? `Focus Terminal: ${name}` : 'Focus Terminal',
      running: name ? `Focusing terminal: ${name}` : 'Focusing active terminal',
      success: 'Terminal focused',
      error: 'Failed to focus terminal',
    };
  }
 
  async call(context: {
    env: any;
    parameters: { terminalName?: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { terminalName } = context.parameters;
 
    const terminal = terminalName
      ? vscode.window.terminals.find(t => t.name === terminalName)
      : vscode.window.activeTerminal;
 
    if (!terminal) {
      context.pushError(JSON.stringify({
        status: 'not_found',
        error: terminalName ? `Terminal "${terminalName}" not found` : 'No active terminal',
      }, null, 2));
      return;
    }
 
    terminal.show();
 
    context.pushResult(JSON.stringify({
      status: 'success',
      message: 'Terminal focused',
      terminalName: terminal.name,
    }, null, 2));
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register all terminal console tools with Bob's source registry.
 */
export function registerTerminalConsoleTools(source: any) {
  source.registerTool(new ListTerminalsTool());
  source.registerTool(new GetTerminalOutputTool());
  source.registerTool(new SearchTerminalOutputTool());
  source.registerTool(new FocusTerminalTool());
}
