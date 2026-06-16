import * as vscode from 'vscode';

// ─── Tool classes ────────────────────────────────────────────────────────────

export class StepOverTool {
  static id = 'step_over';
  groups = ['edit'];
  parameters = [];

  getId() { return StepOverTool.id; }

  getDescription(_options?: any): string {
    return `## step_over
Description: Step over the current line in the active debug session. Executes the current line and moves to the next line, stepping over function calls.

Parameters: None

Usage:
<step_over>
</step_over>`;
  }

  getCostEffectiveDescription(): string {
    return 'Step over the current line in the active debug session';
  }

  toolUseDescription(): string {
    return 'Stepping over...';
  }

  async call(context: {
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
  parameters = [];

  getId() { return StepIntoTool.id; }

  getDescription(_options?: any): string {
    return `## step_into
Description: Step into the function call at the current line in the active debug session. Enters the function to debug its internals.

Parameters: None

Usage:
<step_into>
</step_into>`;
  }

  getCostEffectiveDescription(): string {
    return 'Step into the function call at the current line';
  }

  toolUseDescription(): string {
    return 'Stepping into...';
  }

  async call(context: {
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
  parameters = [];

  getId() { return StepOutTool.id; }

  getDescription(_options?: any): string {
    return `## step_out
Description: Step out of the current function in the active debug session. Continues execution until the current function returns.

Parameters: None

Usage:
<step_out>
</step_out>`;
  }

  getCostEffectiveDescription(): string {
    return 'Step out of the current function';
  }

  toolUseDescription(): string {
    return 'Stepping out...';
  }

  async call(context: {
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
  parameters = [];

  getId() { return ContinueTool.id; }

  getDescription(_options?: any): string {
    return `## continue
Description: Continue execution in the active debug session. Resumes program execution until the next breakpoint or program termination.

Parameters: None

Usage:
<continue>
</continue>`;
  }

  getCostEffectiveDescription(): string {
    return 'Continue execution until the next breakpoint';
  }

  toolUseDescription(): string {
    return 'Continuing execution...';
  }

  async call(context: {
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
  parameters = [];

  getId() { return PauseTool.id; }

  getDescription(_options?: any): string {
    return `## pause
Description: Pause execution in the active debug session. Interrupts the running program to inspect its current state.

Parameters: None

Usage:
<pause>
</pause>`;
  }

  getCostEffectiveDescription(): string {
    return 'Pause execution in the active debug session';
  }

  toolUseDescription(): string {
    return 'Pausing execution...';
  }

  async call(context: {
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
