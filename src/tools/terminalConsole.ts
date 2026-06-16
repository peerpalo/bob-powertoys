import * as vscode from 'vscode';

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
  parameters = [];

  getId() { return ListTerminalsTool.id; }

  getDescription(_options?: any): string {
    return `## list_terminals
Description: List all open terminals with their names, active status, exit status, and output capture information.

Parameters: None

Usage:
<list_terminals>
</list_terminals>`;
  }

  getCostEffectiveDescription(): string {
    return 'List all open terminals with their status and output information';
  }

  toolUseDescription(): string {
    return 'Listing terminals...';
  }

  async call(context: {
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
  parameters = [
    {
      name: 'terminalName',
      required: false,
      type: 'string',
      description: 'Name of the terminal to get output from (defaults to active terminal)',
      usage: 'bash'
    },
    {
      name: 'maxChars',
      required: false,
      type: 'number',
      description: `Maximum characters to return (default and max: ${MAX_TERMINAL_OUTPUT_CHARS})`,
      usage: '1000'
    }
  ];

  getId() { return GetTerminalOutputTool.id; }

  getDescription(_options?: any): string {
    return `## get_terminal_output
Description: Get captured output from a terminal. Output is captured automatically via shell integration. Returns the most recent output up to the specified character limit.

Parameters:
- terminalName: (optional) string. Name of the terminal. Defaults to active terminal.
- maxChars: (optional) number. Maximum characters to return. Default and max: ${MAX_TERMINAL_OUTPUT_CHARS}.

Usage:
<get_terminal_output>
<terminalName>bash</terminalName>
<maxChars>1000</maxChars>
</get_terminal_output>`;
  }

  getCostEffectiveDescription(): string {
    return 'Get captured output from a terminal';
  }

  toolUseDescription(params: any): string {
    return params?.terminalName 
      ? `Getting output from terminal: ${params.terminalName}`
      : 'Getting output from active terminal';
  }

  async call(context: {
    parameters: { terminalName?: string; maxChars?: number };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { terminalName, maxChars = MAX_TERMINAL_OUTPUT_CHARS } = context.parameters;

    const requestedChars = Math.min(maxChars, MAX_TERMINAL_OUTPUT_CHARS);
    
    const terminal = terminalName
      ? vscode.window.terminals.find(t => t.name === terminalName)
      : vscode.window.activeTerminal;
    
    if (!terminal) {
      context.pushError(JSON.stringify({
        error: terminalName
          ? `Terminal "${terminalName}" not found`
          : 'No active terminal'
      }, null, 2));
      return;
    }

    const output = terminalOutputLog.get(terminal) ?? [];
    
    if (output.length === 0) {
      context.pushResult(JSON.stringify({
        terminalName: terminal.name,
        output: '',
        message: 'No output captured. Output is only captured after extension activation and requires shell integration.'
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
      output: recentOutput
    }, null, 2));
  }
}

export class SearchTerminalOutputTool {
  static id = 'search_terminal_output';
  groups = ['read'];
  parameters = [
    {
      name: 'query',
      required: true,
      type: 'string',
      description: 'Regular expression pattern to search for in terminal output',
      usage: 'error|warning'
    },
    {
      name: 'terminalName',
      required: false,
      type: 'string',
      description: 'Name of the terminal to search (defaults to active terminal)',
      usage: 'bash'
    },
    {
      name: 'maxChars',
      required: false,
      type: 'number',
      description: `Maximum characters to return in matches (default and max: ${MAX_TERMINAL_OUTPUT_CHARS})`,
      usage: '1000'
    }
  ];

  getId() { return SearchTerminalOutputTool.id; }

  getDescription(_options?: any): string {
    return `## search_terminal_output
Description: Search terminal output using a regular expression pattern. Returns matching lines with context.

Parameters:
- query: (required) string. Regular expression pattern to search for.
- terminalName: (optional) string. Name of the terminal. Defaults to active terminal.
- maxChars: (optional) number. Maximum characters to return. Default and max: ${MAX_TERMINAL_OUTPUT_CHARS}.

Usage:
<search_terminal_output>
<query>error|warning</query>
<terminalName>bash</terminalName>
</search_terminal_output>`;
  }

  getCostEffectiveDescription(): string {
    return 'Search terminal output using a regular expression pattern';
  }

  toolUseDescription(params: any): string {
    return `Searching for: ${params?.query}`;
  }

  async call(context: {
    parameters: { query: string; terminalName?: string; maxChars?: number };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { query, terminalName, maxChars = MAX_TERMINAL_OUTPUT_CHARS } = context.parameters;

    const requestedChars = Math.min(maxChars, MAX_TERMINAL_OUTPUT_CHARS);
    
    const terminal = terminalName
      ? vscode.window.terminals.find(t => t.name === terminalName)
      : vscode.window.activeTerminal;
    
    if (!terminal) {
      context.pushError(JSON.stringify({
        error: terminalName
          ? `Terminal "${terminalName}" not found`
          : 'No active terminal'
      }, null, 2));
      return;
    }

    const output = terminalOutputLog.get(terminal) ?? [];
    
    if (output.length === 0) {
      context.pushResult(JSON.stringify({
        terminalName: terminal.name,
        query,
        matchedOutput: '',
        message: 'No output captured. Output is only captured after extension activation and requires shell integration.'
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
          if (totalChars + line.length > requestedChars) {
            break;
          }
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
        matchedOutput
      }, null, 2));
    } catch (error) {
      context.pushError(JSON.stringify({
        error: 'Invalid regex pattern',
        query,
        message: error instanceof Error ? error.message : String(error)
      }, null, 2));
    }
  }
}

export class FocusTerminalTool {
  static id = 'focus_terminal';
  groups = ['edit'];
  parameters = [
    {
      name: 'terminalName',
      required: false,
      type: 'string',
      description: 'Name of the terminal to focus (defaults to active terminal)',
      usage: 'bash'
    }
  ];

  getId() { return FocusTerminalTool.id; }

  getDescription(_options?: any): string {
    return `## focus_terminal
Description: Bring a terminal into focus in the VS Code UI. Makes the terminal visible and active.

Parameters:
- terminalName: (optional) string. Name of the terminal to focus. Defaults to active terminal.

Usage:
<focus_terminal>
<terminalName>bash</terminalName>
</focus_terminal>`;
  }

  getCostEffectiveDescription(): string {
    return 'Bring a terminal into focus in the VS Code UI';
  }

  toolUseDescription(params: any): string {
    return params?.terminalName 
      ? `Focusing terminal: ${params.terminalName}`
      : 'Focusing active terminal';
  }

  async call(context: {
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
        error: terminalName
          ? `Terminal "${terminalName}" not found`
          : 'No active terminal'
      }, null, 2));
      return;
    }

    terminal.show();

    context.pushResult(JSON.stringify({
      status: 'success',
      message: 'Terminal focused',
      terminalName: terminal.name
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
