import * as vscode from 'vscode';

// ─── Tool classes ────────────────────────────────────────────────────────────

export class GetActiveDebugSessionTool {
  static id = 'get_active_debug_session';
  groups = ['read'];
  parameters = [];

  getId() { return GetActiveDebugSessionTool.id; }

  getDescription(_options?: any): string {
    return `## get_active_debug_session
Description: Get information about the currently active debug session, including its ID, name, type, and workspace folder.

Parameters: None

Usage:
<get_active_debug_session>
</get_active_debug_session>`;
  }

  getCostEffectiveDescription(): string {
    return 'Get information about the currently active debug session';
  }

  toolUseDescription(): string {
    return 'Getting active debug session...';
  }

  async call(context: {
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const session = vscode.debug.activeDebugSession;

    if (!session) {
      context.pushResult('No active debug session');
      return;
    }

    const sessionInfo = {
      id: session.id,
      name: session.name,
      type: session.type,
      workspaceFolder: session.workspaceFolder?.uri.fsPath,
    };

    context.pushResult(JSON.stringify(sessionInfo, null, 2));
  }
}

export class ListDebugConfigurationsTool {
  static id = 'list_debug_configurations';
  groups = ['read'];
  parameters = [];

  getId() { return ListDebugConfigurationsTool.id; }

  getDescription(_options?: any): string {
    return `## list_debug_configurations
Description: List all available debug configurations from launch.json files in all workspace folders. Shows configuration names, types, and settings.

Parameters: None

Usage:
<list_debug_configurations>
</list_debug_configurations>`;
  }

  getCostEffectiveDescription(): string {
    return 'List all available debug configurations from workspace launch.json files';
  }

  toolUseDescription(): string {
    return 'Listing debug configurations...';
  }

  async call(context: {
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    
    if (!workspaceFolders || workspaceFolders.length === 0) {
      context.pushResult('No workspace folders open. Cannot read launch.json configurations.');
      return;
    }

    const allConfigs: any[] = [];
    
    for (const folder of workspaceFolders) {
      const config = vscode.workspace.getConfiguration('launch', folder.uri);
      const configurations = config.get<any[]>('configurations');
      
      if (configurations && configurations.length > 0) {
        allConfigs.push(...configurations.map((cfg: any) => ({
          ...cfg,
          workspaceFolder: folder.name,
          workspacePath: folder.uri.fsPath,
        })));
      }
    }

    if (allConfigs.length === 0) {
      context.pushResult(JSON.stringify({
        message: 'No debug configurations found in any workspace folder',
        suggestion: 'Create a launch.json file in .vscode folder with debug configurations',
        workspaceFolders: workspaceFolders.map(f => f.uri.fsPath),
      }, null, 2));
      return;
    }

    context.pushResult(JSON.stringify(allConfigs, null, 2));
  }
}

export class StartDebugSessionTool {
  static id = 'start_debug_session';
  groups = ['edit'];
  parameters = [
    {
      name: 'configName',
      required: false,
      type: 'string',
      description: 'Name of the debug configuration to start (from launch.json)',
      usage: 'Launch Program'
    },
    {
      name: 'context',
      required: false,
      type: 'string',
      description: 'Context hint to help select the right configuration (e.g., "attach", "node", "python")',
      usage: 'attach to running process'
    }
  ];

  getId() { return StartDebugSessionTool.id; }

  getDescription(_options?: any): string {
    return `## start_debug_session
Description: Start a debug session using a configuration from launch.json. Can specify a configuration by name or provide context to auto-select the best match.

Parameters:
- configName: (optional) string. Exact name of the debug configuration to use.
- context: (optional) string. Context hint to help select configuration (e.g., "attach", "node", "python").

Usage:
<start_debug_session>
<configName>Launch Program</configName>
</start_debug_session>

Or with context:
<start_debug_session>
<context>attach to running node process</context>
</start_debug_session>`;
  }

  getCostEffectiveDescription(): string {
    return 'Start a debug session using a configuration from launch.json';
  }

  toolUseDescription(params: any): string {
    if (params?.configName) {
      return `Starting debug session: ${params.configName}`;
    }
    return 'Starting debug session...';
  }

  async call(context: {
    parameters: { configName?: string; context?: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { configName, context: debugContext } = context.parameters;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    
    if (!workspaceFolders || workspaceFolders.length === 0) {
      context.pushError('No workspace folders open. Cannot start debug session.');
      return;
    }

    const allConfigs: Array<{ config: vscode.DebugConfiguration; folder: vscode.WorkspaceFolder }> = [];
    
    for (const folder of workspaceFolders) {
      const config = vscode.workspace.getConfiguration('launch', folder.uri);
      const configurations = config.get<vscode.DebugConfiguration[]>('configurations');
      
      if (configurations && configurations.length > 0) {
        for (const cfg of configurations) {
          allConfigs.push({ config: cfg, folder });
        }
      }
    }

    if (allConfigs.length === 0) {
      context.pushError(JSON.stringify({
        error: 'No debug configurations found',
        suggestion: 'Create a launch.json file with appropriate debug configurations',
        workspaceFolders: workspaceFolders.map(f => f.uri.fsPath),
      }, null, 2));
      return;
    }

    let selectedConfig: { config: vscode.DebugConfiguration; folder: vscode.WorkspaceFolder } | null = null;

    if (configName) {
      selectedConfig = allConfigs.find(c => c.config.name === configName) || null;
      if (!selectedConfig) {
        context.pushError(`Configuration "${configName}" not found. Available: ${allConfigs.map(c => c.config.name).join(', ')}`);
        return;
      }
    } else if (allConfigs.length === 1) {
      selectedConfig = allConfigs[0];
    } else {
      if (debugContext) {
        const contextLower = debugContext.toLowerCase();
        
        let bestMatch = allConfigs.find(c =>
          c.config.name.toLowerCase().includes(contextLower)
        );

        if (!bestMatch) {
          bestMatch = allConfigs.find(c => {
            const configStr = JSON.stringify(c.config).toLowerCase();
            return configStr.includes(contextLower);
          });
        }

        if (!bestMatch && (contextLower.includes('attach') || contextLower.includes('running'))) {
          bestMatch = allConfigs.find(c =>
            c.config.request === 'attach' || c.config.name.toLowerCase().includes('attach')
          );
        }

        selectedConfig = bestMatch || allConfigs[0];
      } else {
        selectedConfig = allConfigs.find(c => c.config.request === 'launch') || allConfigs[0];
      }
    }

    if (!selectedConfig) {
      context.pushError(JSON.stringify({
        error: 'Could not select a debug configuration',
        availableConfigs: allConfigs.map(c => c.config.name)
      }, null, 2));
      return;
    }

    try {
      const success = await vscode.debug.startDebugging(
        selectedConfig.folder,
        selectedConfig.config
      );

      if (success) {
        context.pushResult(JSON.stringify({
          status: 'success',
          message: 'Debug session started successfully',
          configuration: selectedConfig.config.name,
          type: selectedConfig.config.type,
          request: selectedConfig.config.request,
          workspaceFolder: selectedConfig.folder.name,
        }, null, 2));
      } else {
        context.pushError(JSON.stringify({
          status: 'failed',
          error: 'Failed to start debug session',
          configuration: selectedConfig.config.name
        }, null, 2));
      }
    } catch (error) {
      context.pushError(JSON.stringify({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        configuration: selectedConfig.config.name
      }, null, 2));
    }
  }
}

export class StopDebugSessionTool {
  static id = 'stop_debug_session';
  groups = ['edit'];
  parameters = [];

  getId() { return StopDebugSessionTool.id; }

  getDescription(_options?: any): string {
    return `## stop_debug_session
Description: Stop the currently active debug session. Terminates the debugging process and cleans up resources.

Parameters: None

Usage:
<stop_debug_session>
</stop_debug_session>`;
  }

  getCostEffectiveDescription(): string {
    return 'Stop the currently active debug session';
  }

  toolUseDescription(): string {
    return 'Stopping debug session...';
  }

  async call(context: {
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const session = vscode.debug.activeDebugSession;

    if (!session) {
      context.pushResult(JSON.stringify({
        status: 'no_session',
        message: 'No active debug session to stop'
      }, null, 2));
      return;
    }

    try {
      await vscode.debug.stopDebugging(session);
      context.pushResult(JSON.stringify({
        status: 'success',
        message: 'Debug session stopped successfully',
        session: session.name
      }, null, 2));
    } catch (error) {
      context.pushError(JSON.stringify({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        session: session.name
      }, null, 2));
    }
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register all debug session tools with Bob's source registry.
 */
export function registerDebugSessionTools(source: any) {
  source.registerTool(new GetActiveDebugSessionTool());
  source.registerTool(new ListDebugConfigurationsTool());
  source.registerTool(new StartDebugSessionTool());
  source.registerTool(new StopDebugSessionTool());
}
