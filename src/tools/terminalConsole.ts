import * as vscode from 'vscode';
import { paramsToSchema } from '../utils.js';

const terminalOutputLog = new Map<vscode.Terminal, string[]>();
const MAX_TERMINAL_OUTPUT_CHARS = 1000;

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[mGKHFJK]/g, '');
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

      (async () => {
        try {
          for await (const chunk of event.execution.read()) {
            const log = terminalOutputLog.get(terminal);
            if (log) {
              log.push(stripAnsi(chunk));
              if (log.length > 1000) {
                log.shift();
              }
            }
          }
        } catch (error) {
          // Ignore errors
        }
      })();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution(async event => {
      const terminal = event.terminal;
      if (!terminalOutputLog.has(terminal)) {
        terminalOutputLog.set(terminal, []);
      }
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
  parameters = ListTerminalsTool.PARAMS;

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
    return `Get captured output from a terminal. Output is captured automatically via shell integration. Returns the most recent output up to the specified character limit (default and max: ${MAX_TERMINAL_OUTPUT_CHARS}).`;
  }
 
  getCostEffectiveDescription(): string {
    return 'Get captured output from a terminal';
  }
 
  // Shared param definition
  private static readonly PARAMS = [
    { name: 'terminalName', type: 'string', detail: 'Name of the terminal to get output from (defaults to active terminal)', description: 'Name of the terminal to get output from (defaults to active terminal)', required: false, usage: 'bash' },
    { name: 'maxChars', type: 'number', detail: `Maximum characters to return (default and max: ${MAX_TERMINAL_OUTPUT_CHARS})`, description: `Maximum characters to return (default and max: ${MAX_TERMINAL_OUTPUT_CHARS})`, required: false, usage: '1000' },
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
    parameters: { terminalName?: string; maxChars?: number };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { terminalName, maxChars = MAX_TERMINAL_OUTPUT_CHARS } = context.parameters;
    const requestedChars = Math.min(maxChars ?? MAX_TERMINAL_OUTPUT_CHARS, MAX_TERMINAL_OUTPUT_CHARS);
 
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
        output: '',
        message: 'No output captured. Output is only captured after extension activation and requires shell integration.',
      }, null, 2));
      return;
    }
 
    const fullOutput = output.join('');
    const recentOutput = fullOutput.slice(-requestedChars);
 
    context.pushResult(JSON.stringify({
      terminalName: terminal.name,
      totalChars: fullOutput.length,
      returnedChars: recentOutput.length,
      maxChars: MAX_TERMINAL_OUTPUT_CHARS,
      output: recentOutput,
    }, null, 2));
  }
}
 
export class SearchTerminalOutputTool {
  static id = 'search_terminal_output';
  groups = ['read'];
  permission = 'read';
 
  getId() { return SearchTerminalOutputTool.id; }
 
  getDescription(_env?: any): string {
    return 'Search terminal output using a regular expression pattern. Returns matching lines with context.';
  }
 
  getCostEffectiveDescription(): string {
    return 'Search terminal output using a regular expression pattern';
  }
 
  // Shared param definition
  private static readonly PARAMS = [
    { name: 'query', type: 'string', detail: 'Regular expression pattern to search for in terminal output', description: 'Regular expression pattern to search for in terminal output', required: true, usage: 'error|warning' },
    { name: 'terminalName', type: 'string', detail: 'Name of the terminal to search (defaults to active terminal)', description: 'Name of the terminal to search (defaults to active terminal)', required: false, usage: 'bash' },
    { name: 'maxChars', type: 'number', detail: `Maximum characters to return in matches (default and max: ${MAX_TERMINAL_OUTPUT_CHARS})`, description: `Maximum characters to return in matches (default and max: ${MAX_TERMINAL_OUTPUT_CHARS})`, required: false, usage: '1000' },
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
    parameters: { query: string; terminalName?: string; maxChars?: number };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { query, terminalName, maxChars = MAX_TERMINAL_OUTPUT_CHARS } = context.parameters;
    const requestedChars = Math.min(maxChars ?? MAX_TERMINAL_OUTPUT_CHARS, MAX_TERMINAL_OUTPUT_CHARS);
 
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
 
    try {
      const regex = new RegExp(query, 'i');
      const matches: string[] = [];
      let totalChars = 0;
 
      for (let i = 0; i < output.length; i++) {
        if (regex.test(output[i])) {
          const line = output[i];
          if (totalChars + line.length > requestedChars) break;
          matches.push(line);
          totalChars += line.length;
        }
      }
 
      const matchedOutput = matches.join('');
 
      context.pushResult(JSON.stringify({
        terminalName: terminal.name,
        query,
        totalLines: output.length,
        matchedLines: matches.length,
        matchedChars: matchedOutput.length,
        maxChars: MAX_TERMINAL_OUTPUT_CHARS,
        matchedOutput,
      }, null, 2));
    } catch (error) {
      context.pushError(JSON.stringify({
        error: 'Invalid regex pattern',
        query,
        message: error instanceof Error ? error.message : String(error),
      }, null, 2));
    }
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
