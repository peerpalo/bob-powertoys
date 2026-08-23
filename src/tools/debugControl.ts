import * as vscode from 'vscode';
import { paramsToSchema } from '../utils.js';

// ─── Tool classes ────────────────────────────────────────────────────────────

export class StepOverTool {
  static id = 'step_over';
  groups = ['edit'];
  permission = 'edit';

  getId() { return StepOverTool.id; }

  getDescription(_env?: any): string {
    return 'Step over the current line in the active debug session. Executes the current line and moves to the next line, stepping over function calls.';
  }

  getCostEffectiveDescription(): string {
    return 'Step over the current line in the active debug session';
  }

  // Shared param definition
  private static readonly PARAMS: any[] = [];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(StepOverTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return StepOverTool.PARAMS;
  }

  getLabels(_args: Record<string, any>) {
    return {
      displayName: 'Step Over',
      running: 'Stepping over...',
      success: 'Stepped over',
      error: 'Failed to step over',
    };
  }

  async call(context: {
    env: any;
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      context.pushError('No active debug session');
      return;
    }

    await vscode.commands.executeCommand('workbench.action.debug.stepOver');
    context.pushResult(JSON.stringify({
      action: 'step_over',
      status: 'success',
      session: session.name
    }, null, 2));
  }
}

export class StepIntoTool {
  static id = 'step_into';
  groups = ['edit'];
  permission = 'edit';

  getId() { return StepIntoTool.id; }

  getDescription(_env?: any): string {
    return 'Step into the function call at the current line in the active debug session. Enters the function to debug its internals.';
  }

  getCostEffectiveDescription(): string {
    return 'Step into the function call at the current line';
  }

  // Shared param definition
  private static readonly PARAMS: any[] = [];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(StepIntoTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return StepIntoTool.PARAMS;
  }

  getLabels(_args: Record<string, any>) {
    return {
      displayName: 'Step Into',
      running: 'Stepping into...',
      success: 'Stepped into',
      error: 'Failed to step into',
    };
  }

  async call(context: {
    env: any;
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      context.pushError('No active debug session');
      return;
    }

    await vscode.commands.executeCommand('workbench.action.debug.stepInto');
    context.pushResult(JSON.stringify({
      action: 'step_into',
      status: 'success',
      session: session.name
    }, null, 2));
  }
}

export class StepOutTool {
  static id = 'step_out';
  groups = ['edit'];
  permission = 'edit';

  getId() { return StepOutTool.id; }

  getDescription(_env?: any): string {
    return 'Step out of the current function in the active debug session. Continues execution until the current function returns.';
  }

  getCostEffectiveDescription(): string {
    return 'Step out of the current function';
  }

  // Shared param definition
  private static readonly PARAMS: any[] = [];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(StepOutTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return StepOutTool.PARAMS;
  }

  getLabels(_args: Record<string, any>) {
    return {
      displayName: 'Step Out',
      running: 'Stepping out...',
      success: 'Stepped out',
      error: 'Failed to step out',
    };
  }

  async call(context: {
    env: any;
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      context.pushError('No active debug session');
      return;
    }

    await vscode.commands.executeCommand('workbench.action.debug.stepOut');
    context.pushResult(JSON.stringify({
      action: 'step_out',
      status: 'success',
      session: session.name
    }, null, 2));
  }
}

export class ContinueTool {
  static id = 'continue';
  groups = ['edit'];
  permission = 'edit';

  getId() { return ContinueTool.id; }

  getDescription(_env?: any): string {
    return 'Continue execution in the active debug session. Resumes program execution until the next breakpoint or program termination.';
  }

  getCostEffectiveDescription(): string {
    return 'Continue execution until the next breakpoint';
  }

  // Shared param definition
  private static readonly PARAMS: any[] = [];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(ContinueTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return ContinueTool.PARAMS;
  }

  getLabels(_args: Record<string, any>) {
    return {
      displayName: 'Continue',
      running: 'Continuing execution...',
      success: 'Execution continued',
      error: 'Failed to continue execution',
    };
  }

  async call(context: {
    env: any;
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      context.pushError('No active debug session');
      return;
    }

    await vscode.commands.executeCommand('workbench.action.debug.continue');
    context.pushResult(JSON.stringify({
      action: 'continue',
      status: 'success',
      session: session.name
    }, null, 2));
  }
}

export class PauseTool {
  static id = 'pause';
  groups = ['edit'];
  permission = 'edit';

  getId() { return PauseTool.id; }

  getDescription(_env?: any): string {
    return 'Pause execution in the active debug session. Interrupts the running program to inspect its current state.';
  }

  getCostEffectiveDescription(): string {
    return 'Pause execution in the active debug session';
  }

  // Shared param definition
  private static readonly PARAMS: any[] = [];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(PauseTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return PauseTool.PARAMS;
  }

  getLabels(_args: Record<string, any>) {
    return {
      displayName: 'Pause',
      running: 'Pausing execution...',
      success: 'Execution paused',
      error: 'Failed to pause execution',
    };
  }

  async call(context: {
    env: any;
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      context.pushError('No active debug session');
      return;
    }

    await vscode.commands.executeCommand('workbench.action.debug.pause');
    context.pushResult(JSON.stringify({
      action: 'pause',
      status: 'success',
      session: session.name
    }, null, 2));
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register all debug control tools with Bob's source registry.
 */
export function registerDebugControlTools(source: any) {
  source.registerTool(new StepOverTool());
  source.registerTool(new StepIntoTool());
  source.registerTool(new StepOutTool());
  source.registerTool(new ContinueTool());
  source.registerTool(new PauseTool());
}
