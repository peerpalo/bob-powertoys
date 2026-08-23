import * as vscode from 'vscode';
import { paramsToSchema } from '../utils.js';

// ─── Tool classes ────────────────────────────────────────────────────────────

export class ListExtensionsTool {
  static id = 'list_extensions';
  groups = ['read'];
  permission = 'read';

  getId() { return ListExtensionsTool.id; }

  getDescription(_env?: any): string {
    return [
      'List all extensions installed in Bob, including their ID, display name, version,',
      'enabled/active status, and whether they are built-in.',
      'Use this to check if a specific extension is installed before suggesting',
      'extension-specific workflows or debug configurations.',
    ].join(' ');
  }

  getCostEffectiveDescription(): string {
    return 'List all installed Bob extensions with their status and version';
  }

  private static readonly PARAMS = [
    {
      name: 'filter',
      type: 'string',
      description: 'Optional substring to filter extensions by ID or display name (case-insensitive).',
      detail: 'Filter by ID or display name (optional)',
      required: false,
      usage: 'python',
    },
    {
      name: 'include_builtin',
      type: 'boolean',
      description: 'Whether to include built-in extensions in the results. Defaults to false.',
      detail: 'Include built-in extensions (default: false)',
      required: false,
      usage: 'false',
    },
  ];

  parameters = paramsToSchema(ListExtensionsTool.PARAMS);

  getParameters(_env?: any): any[] {
    return ListExtensionsTool.PARAMS;
  }

  getLabels(args: Record<string, any>) {
    const filter = args?.filter as string | undefined;
    return {
      displayName: filter ? `List Extensions: ${filter}` : 'List Extensions',
      running: 'Listing extensions...',
      success: 'Listed extensions',
      error: 'Failed to list extensions',
    };
  }

  async call(context: {
    env: any;
    parameters: { filter?: string; include_builtin?: boolean };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { filter, include_builtin = false } = context.parameters;
    const filterLower = filter?.toLowerCase();

    const extensions = vscode.extensions.all
      .filter(ext => include_builtin || !ext.packageJSON?.isBuiltin)
      .filter(ext => {
        if (!filterLower) { return true; }
        const id = ext.id.toLowerCase();
        const name = (ext.packageJSON?.displayName ?? ext.packageJSON?.name ?? '').toLowerCase();
        return id.includes(filterLower) || name.includes(filterLower);
      })
      .map(ext => ({
        id: ext.id,
        displayName: ext.packageJSON?.displayName ?? ext.packageJSON?.name ?? ext.id,
        version: ext.packageJSON?.version ?? 'unknown',
        isActive: ext.isActive,
        isBuiltin: ext.packageJSON?.isBuiltin ?? false,
        publisher: ext.packageJSON?.publisher ?? 'unknown',
        description: ext.packageJSON?.description ?? '',
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    context.pushResult(JSON.stringify({
      total: extensions.length,
      extensions,
    }, null, 2));
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerBobExtensionsTools(source: any) {
  source.registerTool(new ListExtensionsTool());
}
