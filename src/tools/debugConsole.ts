import * as vscode from 'vscode';
import { resolveFrameId } from '../utils.js';
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
  permission = 'read';

  getId() { return EvaluateExpressionTool.id; }

  getDescription(_env?: any): string {
    return 'Evaluate an expression in the current debug session context. Requires the debugger to be paused at a breakpoint. Automatically expands object references.';
  }

  getCostEffectiveDescription(): string {
    return 'Evaluate an expression in the active debug session (requires breakpoint pause)';
  }

  // Shared param definition
  private static readonly PARAMS = [
    { name: 'expression', required: true,  type: 'string', detail: 'Expression to evaluate in the current debug context', description: 'Expression to evaluate in the current debug context', usage: 'myVariable' },
    { name: 'frameId',    required: false, type: 'number', detail: 'Stack frame ID (defaults to top frame)', description: 'Stack frame ID (defaults to top frame)', usage: '1' },
    { name: 'context',    required: false, type: 'string', detail: 'Evaluation context: repl, watch, or hover (default: repl)', description: 'Evaluation context: repl, watch, or hover (default: repl)', usage: 'repl' },
    { name: 'expand',     required: false, type: 'string', detail: 'Expand object references: true or false (default: true)', description: 'Expand object references: true or false (default: true)', usage: 'true' },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = EvaluateExpressionTool.PARAMS;

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return EvaluateExpressionTool.PARAMS;
  }

  getLabels(args: Record<string, any>) {
    const expr = args?.expression ?? '...';
    return {
      displayName: `Evaluate: ${expr}`,
      running: `Evaluating: ${expr}`,
      success: `Evaluated: ${expr}`,
      error: `Failed to evaluate: ${expr}`,
    };
  }

  async call(context: {
    env: any;
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
  permission = 'read';

  getId() { return GetVariablesTool.id; }

  getDescription(_env?: any): string {
    return 'Retrieve variables for a given variables reference ID obtained from a previous evaluate_expression or get_scopes call. Use this to drill into nested objects.';
  }

  getCostEffectiveDescription(): string {
    return 'Retrieve variables for a variables reference ID from the active debug session';
  }

  // Shared param definition
  private static readonly PARAMS = [
    { name: 'variablesReference', required: true,  type: 'number', detail: 'The variables reference ID from a previous evaluation', description: 'The variables reference ID from a previous evaluation', usage: '1' },
    { name: 'filter',             required: false, type: 'string', detail: 'Filter variables: indexed or named', description: 'Filter variables: indexed or named', usage: 'named' },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = GetVariablesTool.PARAMS;

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return GetVariablesTool.PARAMS;
  }

  getLabels(args: Record<string, any>) {
    return {
      displayName: 'Get Variables',
      running: `Getting variables for reference: ${args?.variablesReference ?? '...'}`,
      success: 'Got variables',
      error: 'Failed to get variables',
    };
  }

  async call(context: {
    env: any;
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
  permission = 'read';

  getId() { return GetStackTraceTool.id; }

  getDescription(_env?: any): string {
    return 'Retrieve the call stack for the current debug session. Shows all stack frames with file locations and line numbers.';
  }

  getCostEffectiveDescription(): string {
    return 'Retrieve the call stack from the active debug session';
  }

  // Shared param definition
  private static readonly PARAMS = [
    { name: 'threadId',   required: false, type: 'number', detail: 'Thread ID (defaults to stopped thread)', description: 'Thread ID (defaults to stopped thread)', usage: '1' },
    { name: 'startFrame', required: false, type: 'number', detail: 'Starting frame index (default: 0)', description: 'Starting frame index (default: 0)', usage: '0' },
    { name: 'levels',     required: false, type: 'number', detail: 'Number of frames to retrieve (default: 20)', description: 'Number of frames to retrieve (default: 20)', usage: '20' },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = GetStackTraceTool.PARAMS;

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return GetStackTraceTool.PARAMS;
  }

  getLabels(args: Record<string, any>) {
    const suffix = args?.threadId !== undefined ? ` (thread ${args.threadId})` : '';
    return {
      displayName: `Get Stack Trace${suffix}`,
      running: `Getting stack trace${suffix}...`,
      success: `Got stack trace${suffix}`,
      error: 'Failed to get stack trace',
    };
  }

  async call(context: {
    env: any;
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
  permission = 'read';

  getId() { return GetScopesTool.id; }

  getDescription(_env?: any): string {
    return 'Retrieve the variable scopes for a given stack frame. Returns scope names and their variablesReference IDs which can be passed to get_variables.';
  }

  getCostEffectiveDescription(): string {
    return 'Retrieve variable scopes for a stack frame in the active debug session';
  }

  // Shared param definition
  private static readonly PARAMS = [
    { name: 'frameId', required: false, type: 'number', detail: 'Stack frame ID (defaults to top frame)', description: 'Stack frame ID (defaults to top frame)', usage: '1' },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = GetScopesTool.PARAMS;

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return GetScopesTool.PARAMS;
  }

  getLabels(args: Record<string, any>) {
    const suffix = args?.frameId !== undefined ? ` (frame ${args.frameId})` : '';
    return {
      displayName: `Get Scopes${suffix}`,
      running: `Getting scopes${suffix}...`,
      success: `Got scopes${suffix}`,
      error: 'Failed to get scopes',
    };
  }

  async call(context: {
    env: any;
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
  permission = 'edit';

  getId() { return SetVariableTool.id; }

  getDescription(_env?: any): string {
    return 'Set the value of a variable in the active debug session. Requires the debugger to be paused.';
  }

  getCostEffectiveDescription(): string {
    return 'Set the value of a variable in the active debug session';
  }

  // Shared param definition
  private static readonly PARAMS = [
    { name: 'variablesReference', required: true, type: 'number', detail: 'The variables reference containing the variable', description: 'The variables reference containing the variable', usage: '1' },
    { name: 'name',               required: true, type: 'string', detail: 'The name of the variable to set', description: 'The name of the variable to set', usage: 'myVar' },
    { name: 'value',              required: true, type: 'string', detail: 'The new value for the variable (as string)', description: 'The new value for the variable (as string)', usage: '42' },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = SetVariableTool.PARAMS;

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return SetVariableTool.PARAMS;
  }

  getLabels(args: Record<string, any>) {
    return {
      displayName: 'Set Variable',
      running: `Setting ${args?.name ?? '...'} = ${args?.value ?? '...'}`,
      success: 'Variable set',
      error: 'Failed to set variable',
    };
  }

  async call(context: {
    env: any;
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
  permission = 'read';

  getId() { return GetDebugOutputTool.id; }

  getDescription(_env?: any): string {
    return 'Retrieve captured output from the debug console. Output is captured automatically during debug sessions via the Debug Adapter Protocol.';
  }

  getCostEffectiveDescription(): string {
    return 'Retrieve captured output from the debug console';
  }

  // Shared param definition
  private static readonly PARAMS = [
    { name: 'lines',    required: false, type: 'number', detail: 'Number of recent lines to return (default: 100)', description: 'Number of recent lines to return (default: 100)', usage: '100' },
    { name: 'category', required: false, type: 'string', detail: 'Filter by category: console, stdout, or stderr', description: 'Filter by category: console, stdout, or stderr', usage: 'stdout' },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = GetDebugOutputTool.PARAMS;

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return GetDebugOutputTool.PARAMS;
  }

  getLabels(args: Record<string, any>) {
    return {
      displayName: 'Get Debug Output',
      running: `Reading debug output${args?.category ? ` (${args.category})` : ''}...`,
      success: 'Got debug output',
      error: 'Failed to get debug output',
    };
  }

  async call(context: {
    env: any;
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
