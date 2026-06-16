import * as vscode from 'vscode';
import { resolveFrameId } from './utils.js';
import { getCurrentStoppedState } from '../debugAdapter.js';

// Store debug output from DAP
const debugOutputLog: { category: string; output: string; timestamp: Date }[] = [];

/**
 * Resolve the top frame ID from the active debug session
 */
async function resolveTopFrameId(session: vscode.DebugSession): Promise<number | undefined> {
  const currentStoppedState = getCurrentStoppedState();
  
  if (currentStoppedState?.frameId !== undefined) {
    return currentStoppedState.frameId;
  }
  if (currentStoppedState?.threadId !== undefined) {
    try {
      const stack = await session.customRequest('stackTrace', {
        threadId: currentStoppedState.threadId,
        levels: 1,
      });
      return stack.stackFrames[0]?.id;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ─── Tool classes ────────────────────────────────────────────────────────────

export class EvaluateExpressionTool {
  static id = 'evaluate_expression';
  groups = ['read'];
  parameters = [
    { name: 'expression', required: true,  type: 'string', description: 'Expression to evaluate in the current debug context', usage: 'myVariable' },
    { name: 'frameId',    required: false, type: 'number', description: 'Stack frame ID (defaults to top frame)', usage: '1' },
    { name: 'context',    required: false, type: 'string', description: 'Evaluation context: repl, watch, or hover (default: repl)', usage: 'repl' },
    { name: 'expand',     required: false, type: 'string', description: 'Expand object references: true or false (default: true)', usage: 'true' },
  ];

  getId() { return EvaluateExpressionTool.id; }

  getDescription(_options?: any): string {
    return `## evaluate_expression
Description: Evaluate an expression in the current debug session context. Requires the debugger to be paused at a breakpoint. Automatically expands object references.

Parameters:
- expression: (required) string. The expression to evaluate.
- frameId: (optional) number. Stack frame ID. Defaults to the top frame.
- context: (optional) string. Evaluation context — repl, watch, or hover. Default: repl.
- expand: (optional) string. Whether to expand object references. Default: true.

Usage:
<evaluate_expression>
<expression>myVariable</expression>
<context>repl</context>
</evaluate_expression>`;
  }

  getCostEffectiveDescription(): string {
    return 'Evaluate an expression in the active debug session (requires breakpoint pause)';
  }

  toolUseDescription(params: any): string {
    return `Evaluating: ${params?.expression ?? '...'}`;
  }

  async call(context: {
    parameters: { expression: string; frameId?: number; context?: string; expand?: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      context.pushError('No active debug session');
      return;
    }

    const { expression, frameId, context: evalContext = 'repl', expand = 'true' } = context.parameters;
    const shouldExpand = expand !== 'false';

    try {
      const resolvedFrameId = await resolveFrameId(frameId, () => resolveTopFrameId(session));

      if (resolvedFrameId === undefined) {
        context.pushError('Cannot evaluate: debugger is not paused at a breakpoint.');
        return;
      }

      const result = await session.customRequest('evaluate', {
        expression,
        frameId: resolvedFrameId,
        context: evalContext,
      });

      let variables;
      if (shouldExpand && result.variablesReference > 0) {
        const expanded = await session.customRequest('variables', {
          variablesReference: result.variablesReference,
        });
        variables = expanded.variables.map((v: any) => ({
          name: v.name,
          value: v.value,
          type: v.type,
          variablesReference: v.variablesReference,
        }));
      }

      context.pushResult(JSON.stringify({ result: result.result, type: result.type, variables }, null, 2));
    } catch (error) {
      context.pushError(`Error evaluating expression: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class GetVariablesTool {
  static id = 'get_variables';
  groups = ['read'];
  parameters = [
    { name: 'variablesReference', required: true,  type: 'number', description: 'The variables reference ID from a previous evaluation', usage: '1' },
    { name: 'filter',             required: false, type: 'string', description: 'Filter variables: indexed or named', usage: 'named' },
  ];

  getId() { return GetVariablesTool.id; }

  getDescription(_options?: any): string {
    return `## get_variables
Description: Retrieve variables for a given variables reference ID obtained from a previous evaluate_expression or get_scopes call. Use this to drill into nested objects.

Parameters:
- variablesReference: (required) number. The reference ID to expand.
- filter: (optional) string. Filter by indexed or named variables.

Usage:
<get_variables>
<variablesReference>1</variablesReference>
</get_variables>`;
  }

  getCostEffectiveDescription(): string {
    return 'Retrieve variables for a variables reference ID from the active debug session';
  }

  toolUseDescription(params: any): string {
    return `Getting variables for reference: ${params?.variablesReference}`;
  }

  async call(context: {
    parameters: { variablesReference: number; filter?: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      context.pushError('No active debug session');
      return;
    }

    try {
      const result = await session.customRequest('variables', {
        variablesReference: context.parameters.variablesReference,
        filter: context.parameters.filter,
      });
      context.pushResult(JSON.stringify(result.variables, null, 2));
    } catch (error) {
      context.pushError(`Error getting variables: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class GetStackTraceTool {
  static id = 'get_stack_trace';
  groups = ['read'];
  parameters = [
    { name: 'threadId',   required: false, type: 'number', description: 'Thread ID (defaults to stopped thread)', usage: '1' },
    { name: 'startFrame', required: false, type: 'number', description: 'Starting frame index (default: 0)', usage: '0' },
    { name: 'levels',     required: false, type: 'number', description: 'Number of frames to retrieve (default: 20)', usage: '20' },
  ];

  getId() { return GetStackTraceTool.id; }

  getDescription(_options?: any): string {
    return `## get_stack_trace
Description: Retrieve the call stack for the current debug session. Shows all stack frames with file locations and line numbers.

Parameters:
- threadId: (optional) number. Thread ID. Defaults to the current stopped thread.
- startFrame: (optional) number. Starting frame index. Default: 0.
- levels: (optional) number. Number of frames to retrieve. Default: 20.

Usage:
<get_stack_trace>
<levels>20</levels>
</get_stack_trace>`;
  }

  getCostEffectiveDescription(): string {
    return 'Retrieve the call stack from the active debug session';
  }

  toolUseDescription(): string {
    return 'Getting stack trace...';
  }

  async call(context: {
    parameters: { threadId?: number; startFrame?: number; levels?: number };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      context.pushError('No active debug session');
      return;
    }

    try {
      let threadId = context.parameters.threadId;
      if (!threadId) {
        const stoppedState = getCurrentStoppedState();
        if (stoppedState?.threadId !== undefined) {
          threadId = stoppedState.threadId;
        } else {
          const threadsResult = await session.customRequest('threads');
          if (threadsResult.threads?.length > 0) {
            threadId = threadsResult.threads[0].id;
          } else {
            context.pushError('No threads available');
            return;
          }
        }
      }

      const result = await session.customRequest('stackTrace', {
        threadId,
        startFrame: context.parameters.startFrame ?? 0,
        levels: context.parameters.levels ?? 20,
      });

      context.pushResult(JSON.stringify({
        stackFrames: result.stackFrames,
        totalFrames: result.totalFrames,
      }, null, 2));
    } catch (error) {
      context.pushError(`Error getting stack trace: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class GetScopesTool {
  static id = 'get_scopes';
  groups = ['read'];
  parameters = [
    { name: 'frameId', required: false, type: 'number', description: 'Stack frame ID (defaults to top frame)', usage: '1' },
  ];

  getId() { return GetScopesTool.id; }

  getDescription(_options?: any): string {
    return `## get_scopes
Description: Retrieve the variable scopes for a given stack frame. Returns scope names and their variablesReference IDs which can be passed to get_variables.

Parameters:
- frameId: (optional) number. Stack frame ID. Defaults to the top frame.

Usage:
<get_scopes>
</get_scopes>`;
  }

  getCostEffectiveDescription(): string {
    return 'Retrieve variable scopes for a stack frame in the active debug session';
  }

  toolUseDescription(): string {
    return 'Getting scopes...';
  }

  async call(context: {
    parameters: { frameId?: number };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      context.pushError('No active debug session');
      return;
    }

    try {
      const resolvedFrameId = await resolveFrameId(
        context.parameters.frameId,
        () => resolveTopFrameId(session)
      );

      if (resolvedFrameId === undefined) {
        context.pushError('Cannot get scopes: debugger is not paused at a breakpoint.');
        return;
      }

      const result = await session.customRequest('scopes', { frameId: resolvedFrameId });
      context.pushResult(JSON.stringify(result.scopes, null, 2));
    } catch (error) {
      context.pushError(`Error getting scopes: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class SetVariableTool {
  static id = 'set_variable';
  groups = ['edit'];
  parameters = [
    { name: 'variablesReference', required: true, type: 'number', description: 'The variables reference containing the variable', usage: '1' },
    { name: 'name',               required: true, type: 'string', description: 'The name of the variable to set', usage: 'myVar' },
    { name: 'value',              required: true, type: 'string', description: 'The new value for the variable (as string)', usage: '42' },
  ];

  getId() { return SetVariableTool.id; }

  getDescription(_options?: any): string {
    return `## set_variable
Description: Set the value of a variable in the active debug session. Requires the debugger to be paused.

Parameters:
- variablesReference: (required) number. The variables reference containing the variable.
- name: (required) string. The name of the variable to modify.
- value: (required) string. The new value to assign.

Usage:
<set_variable>
<variablesReference>1</variablesReference>
<name>myVar</name>
<value>42</value>
</set_variable>`;
  }

  getCostEffectiveDescription(): string {
    return 'Set the value of a variable in the active debug session';
  }

  toolUseDescription(params: any): string {
    return `Setting ${params?.name} = ${params?.value}`;
  }

  async call(context: {
    parameters: { variablesReference: number; name: string; value: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      context.pushError('No active debug session');
      return;
    }

    try {
      const result = await session.customRequest('setVariable', {
        variablesReference: context.parameters.variablesReference,
        name: context.parameters.name,
        value: context.parameters.value,
      });

      context.pushResult(JSON.stringify({
        value: result.value,
        type: result.type,
        variablesReference: result.variablesReference,
      }, null, 2));
    } catch (error) {
      context.pushError(`Error setting variable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class GetDebugOutputTool {
  static id = 'get_debug_output';
  groups = ['read'];
  parameters = [
    { name: 'lines',    required: false, type: 'number', description: 'Number of recent lines to return (default: 100)', usage: '100' },
    { name: 'category', required: false, type: 'string', description: 'Filter by category: console, stdout, or stderr', usage: 'stdout' },
  ];

  getId() { return GetDebugOutputTool.id; }

  getDescription(_options?: any): string {
    return `## get_debug_output
Description: Retrieve captured output from the debug console. Output is captured automatically during debug sessions via the Debug Adapter Protocol.

Parameters:
- lines: (optional) number. Number of recent lines to return. Default: 100.
- category: (optional) string. Filter by output category — console, stdout, or stderr.

Usage:
<get_debug_output>
<lines>100</lines>
</get_debug_output>`;
  }

  getCostEffectiveDescription(): string {
    return 'Retrieve captured output from the debug console';
  }

  toolUseDescription(params: any): string {
    return `Reading debug output${params?.category ? ` (${params.category})` : ''}...`;
  }

  async call(context: {
    parameters: { lines?: number; category?: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { lines = 100, category } = context.parameters;

    let entries = debugOutputLog;
    if (category) {
      entries = entries.filter(e => e.category === category);
    }

    const recent = entries.slice(-lines);
    const text = recent.map(e => `[${e.category}] ${e.output}`).join('');
    context.pushResult(text || '(no debug output captured yet)');
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register all debug console tools with Bob's source registry.
 */
export function registerDebugConsoleTools(source: any) {
  source.registerTool(new EvaluateExpressionTool());
  source.registerTool(new GetVariablesTool());
  source.registerTool(new GetStackTraceTool());
  source.registerTool(new GetScopesTool());
  source.registerTool(new SetVariableTool());
  source.registerTool(new GetDebugOutputTool());
}