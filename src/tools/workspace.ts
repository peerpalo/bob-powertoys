/**
 * Workspace tools - bypass Bob's single-root sandbox so Bob can read any file
 * from any folder in a multi-root VS Code workspace without per-file confirmation.
 *
 * Root cause: Bob's built-in read_file / list_files / grep / glob tools pass
 * only the primary workspace folder to `isOutsideWorkspace()`, so every file in
 * a second or third workspace root triggers the "allow outside workspace?" prompt.
 *
 * These tools use `vscode.workspace.fs` directly from the extension-host process,
 * which has no such sandbox - all workspace folders are treated equally.
 */

import * as vscode from 'vscode';
import { getTaskManager, findTaskChatManager, getBobTool, normaliseWorkspacePath, paramsToSchema, createPatch, absolutiseToolContent, resolveOpenFilePath } from '../utils.js';

/** Return all workspace folder roots as { name, uri, fsPath, index } objects. */
function getWorkspaceFolders() {
  return (vscode.workspace.workspaceFolders ?? []).map(f => ({
    name: f.name,
    uri: f.uri.toString(),
    fsPath: f.uri.fsPath,
    index: f.index,
  }));
}

/**
 * Resolve a file/dir path to a vscode.Uri using an explicit workspace folder name.
 *
 * @param folderName  The workspace folder name as returned by list_workspace_folders.
 * @param filePath    Path relative to that folder root (e.g. "src/app.ts").
 *                    Pass an empty string or "." to refer to the folder root itself.
 * @returns The resolved Uri, or null with a reason string if lookup fails.
 */
function resolveInFolder(
  folderName: string,
  filePath: string
): { uri: vscode.Uri } | { error: string } {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return { error: 'No workspace folders are open.' };
  }

  const folder = folders.find(f => f.name === folderName);
  if (!folder) {
    const names = folders.map(f => f.name).join(', ');
    return { error: `Unknown workspace folder "${folderName}". Available folders: ${names}` };
  }

  const rel = normaliseWorkspacePath(filePath);
  const uri = rel ? vscode.Uri.joinPath(folder.uri, rel) : folder.uri;
  return { uri };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** True when the workspace has more than one root folder. */
function isMultiRoot(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}

// ─── Tool classes ─────────────────────────────────────────────────────────────

export class ListWorkspaceFoldersTool {
  static id = 'list_workspace_folders';
  groups = ['read'];
  permission = 'read';

  getId() { return ListWorkspaceFoldersTool.id; }

  /** Only expose this tool when there are multiple workspace roots. */
  enabled(_env?: any): boolean {
    return isMultiRoot();
  }

  getDescription(_env?: any): string {
    return (
      'List every root folder in the current VS Code workspace. ' +
      'Returns each folder\'s name and fsPath. ' +
      'This workspace is a MULTI-ROOT workspace with folders at completely ' +
      'different paths on disk (e.g. c:\\src\\frontend AND c:\\src\\backend). ' +
      'Bob\'s built-in tools (read_file, list_files, glob, grep) only work for the ' +
      'PRIMARY folder shown in environment_info - they will be blocked for all others. ' +
      'ALWAYS call this first on any task that might touch more than one project. ' +
      'Then pass the folder\'s "name" as the "workspace" parameter to any workspace-scoped tool.'
    );
  }

  getCostEffectiveDescription(): string {
    return 'List all VS Code workspace folder roots - call first, then use folder name as "workspace" param';
  }

  private static readonly PARAMS: any[] = [];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(ListWorkspaceFoldersTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] { return ListWorkspaceFoldersTool.PARAMS; }

  getLabels(_args: Record<string, any>) {
    return {
      displayName: 'List Workspace Folders',
      running: 'Listing workspace folders...',
      success: 'Listed workspace folders',
      error: 'Failed to list workspace folders',
    };
  }

  async call(context: {
    env: any;
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const folders = getWorkspaceFolders();

    if (folders.length === 0) {
      context.pushResult(JSON.stringify({
        folders: [],
        message: 'No workspace folders are open.',
      }, null, 2));
      return;
    }

    context.pushResult(JSON.stringify({
      totalFolders: folders.length,
      note: 'Pass the folder "name" as the "workspace" parameter to any workspace-scoped tool.',
      folders,
    }, null, 2));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class ReadWorkspaceFileTool {
  static id = 'read_workspace_file';
  groups = ['read'];
  permission = 'read';

  getId() { return ReadWorkspaceFileTool.id; }

  /** Only expose this tool when there are multiple workspace roots. */
  enabled(_env?: any): boolean {
    return isMultiRoot();
  }

  getDescription(_env?: any): string {
    return (
      'Read the text content of any file in the VS Code workspace - including files in ' +
      'secondary workspace folders that are OUTSIDE the primary workspace root. ' +
      'MUST be used instead of read_file for any file not under the primary folder. ' +
      'Call list_workspace_folders first to get the folder name, then pass it as "workspace".'
    );
  }

  getCostEffectiveDescription(): string {
    return 'Read file from any workspace folder (use instead of read_file for non-primary folders)';
  }

  private static readonly PARAMS = [
    {
      name: 'workspace',
      type: 'string',
      description: 'Workspace folder name as returned by list_workspace_folders (e.g. "backend").',
      detail: 'Workspace folder name',
      required: true,
      usage: 'backend',
    },
    {
      name: 'path',
      type: 'string',
      description: 'File path relative to the workspace folder root (e.g. "src/app.ts").',
      detail: 'File path relative to workspace folder',
      required: true,
      usage: 'src/server.ts',
    },
    {
      name: 'range',
      type: 'string',
      description: 'One or more line range elements in format "start-end" (1-based, inclusive)',
      detail: 'Line range "start-end" (optional)',
      required: false,
      usage: '1-100',
    },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(ReadWorkspaceFileTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] { return ReadWorkspaceFileTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const p = args?.path ? ` ${args.path}` : '';
    const r = args?.range ? ` (${args.range})` : '';
    return {
      displayName: `Read File${p}${r}`,
      running: `Reading file${p}${r}`,
      success: `Read file${p}${r}`,
      error: `Failed to read file${p}${r}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { workspace: string; path: string; range?: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
    [key: string]: any;
  }): Promise<void> {
    const { workspace, path: filePath, range } = context.parameters;

    const resolved = resolveInFolder(workspace, '');
    if ('error' in resolved) {
      context.pushError(resolved.error);
      return;
    }

    const readFileTool = getBobTool('read_file');
    if (!readFileTool) {
      context.pushError(
        'read_workspace_file: read_file tool not found in current task.'
      );
      return;
    }

    await readFileTool.call({
      ...context,
      env: {
        ...context.env,
        workspace: resolved.uri.fsPath,
      },
      parameters: {
        path: filePath,
        ...(range !== undefined && { range }),
      },
      // Bob's read_file calls p.trackFileRead(uri, mtime) without optional chaining.
      // We can't receive it from the task runner (it's a closure over K), but we can
      // replicate the effect: setMetadata merges into the same K object, so writing
      // into fileMtimes via setMetadata is functionally identical to trackFileRead.
      trackFileRead: (uri: string, mtime: number) => {
        context.setMetadata?.({ fileMtimes: { [uri]: mtime } });
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class ListWorkspaceFilesTool {
  static id = 'list_workspace_files';
  groups = ['read'];
  permission = 'read';

  getId() { return ListWorkspaceFilesTool.id; }

  /** Only expose this tool when there are multiple workspace roots. */
  enabled(_env?: any): boolean {
    return isMultiRoot();
  }

  getDescription(_env?: any): string {
    return (
      'List files and directories inside any folder in the VS Code workspace - including ' +
      'secondary workspace folders OUTSIDE the primary workspace root. ' +
      'MUST be used instead of list_files for any directory not under the primary folder. ' +
      'Call list_workspace_folders first to get the folder name, then pass it as "workspace". ' +
      'Use recursive:true to walk the full subtree (capped at 200 entries).'
    );
  }

  getCostEffectiveDescription(): string {
    return 'List files/dirs in any workspace folder (use instead of list_files for non-primary folders)';
  }

  private static readonly PARAMS = [
    {
      name: 'workspace',
      type: 'string',
      description: 'Workspace folder name as returned by list_workspace_folders (e.g. "backend").',
      detail: 'Workspace folder name',
      required: true,
      usage: 'backend',
    },
    {
      name: 'path',
      type: 'string',
      description: 'Directory path relative to the workspace folder root. Omit or pass "." to list the folder root itself.',
      detail: 'Directory path relative to workspace folder (optional, defaults to root)',
      required: false,
      usage: 'src',
    },
    {
      name: 'recursive',
      type: 'boolean',
      description: 'If true, list files recursively. Defaults to false (top-level only). Recursive listings are capped at 200 entries.',
      detail: 'List recursively (default: false)',
      required: false,
      usage: 'false',
    },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(ListWorkspaceFilesTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] { return ListWorkspaceFilesTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const loc = args?.workspace
      ? `${args.workspace}${args.path ? `/${args.path}` : ''}`
      : (args?.path ?? '.');
    const recursive = args?.recursive ? ' recursively' : '';
    return {
      displayName: `List Files in ${loc}`,
      running: `Listing files in ${loc}${recursive}`,
      success: `Listed files in ${loc}`,
      error: `Failed to list files in ${loc}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { workspace: string; path?: string; recursive?: boolean };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { workspace, path: dirPath = '.', recursive = false } = context.parameters;

    const resolved = resolveInFolder(workspace, '');
    if ('error' in resolved) {
      context.pushError(JSON.stringify({ error: resolved.error }));
      return;
    }

    const listFilesTool = getBobTool('list_files');
    if (!listFilesTool) {
      context.pushError(
        'list_workspace_files: list_files tool not found in current task.'
      );
      return;
    }

    const wsRoot = resolved.uri.fsPath;
    await listFilesTool.call({
      ...context,
      env: { ...context.env, workspace: wsRoot },
      parameters: { path: dirPath, recursive },
      pushResult: (text: string) =>
        context.pushResult(absolutiseToolContent(text, 'glob', wsRoot)),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class GlobWorkspaceTool {
  static id = 'glob_workspace';
  groups = ['read'];
  permission = 'read';

  getId() { return GlobWorkspaceTool.id; }

  /** Only expose this tool when there are multiple workspace roots. */
  enabled(_env?: any): boolean {
    return isMultiRoot();
  }

  getDescription(_env?: any): string {
    return (
      'Find files by name pattern (glob) inside any folder in the VS Code workspace - ' +
      'including secondary workspace folders OUTSIDE the primary workspace root. ' +
      'MUST be used instead of glob for any directory not under the primary folder. ' +
      'Supports * (any chars within a path segment), ** (any path depth), and ? (single char). ' +
      'Examples: "**/*.ts", "src/**/*.test.ts", "*.json". ' +
      'Pass a workspace folder name to scope the search to one folder, or omit to search all. ' +
      'Results are capped at 200 matches.'
    );
  }

  getCostEffectiveDescription(): string {
    return 'Find files by glob pattern in any workspace folder (use instead of glob for non-primary folders)';
  }

  private static readonly PARAMS = [
    {
      name: 'pattern',
      type: 'string',
      detail: 'Glob pattern to match files (e.g. "**/*.ts", "src/**/index.ts").',
      required: true,
      usage: '**/*.ts',
    },
    {
      name: 'workspace',
      type: 'string',
      detail: 'Workspace folder name (from list_workspace_folders). Omit to search all folders.',
      required: false,
      usage: 'backend',
    },
    {
      name: 'path',
      type: 'string',
      detail: 'Directory to search in (relative to the workspace folder root). Defaults to workspace root.',
      required: false,
      usage: 'src',
    },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(GlobWorkspaceTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] { return GlobWorkspaceTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const pat = typeof args?.pattern === 'string' && args.pattern.trim() ? ` with pattern "${args.pattern}"` : '';
    const loc = typeof args?.path === 'string' && args.path.trim()
      ? ` in ${args.workspace ? `${args.workspace}/` : ''}${args.path}`
      : (args?.workspace ? ` in ${args.workspace}` : '');
    return {
      displayName: `Find Files${loc}${pat}`,
      running: `Finding files${loc}${pat}`,
      success: `Found files${loc}${pat}`,
      error: `Failed to find files${loc}${pat}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { pattern: string; workspace?: string; path?: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { pattern, workspace, path: subPath } = context.parameters;

    if (!pattern?.trim()) {
      context.pushError('pattern is required');
      return;
    }

    const globTool = getBobTool('glob');
    if (!globTool) {
      context.pushError('glob_workspace: glob tool not found in current task.');
      return;
    }

    // Determine which workspace roots to search
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      context.pushError(JSON.stringify({ error: 'No workspace folders are open.' }));
      return;
    }

    let roots: Array<vscode.WorkspaceFolder>;
    if (workspace) {
      const resolved = resolveInFolder(workspace, '');
      if ('error' in resolved) {
        context.pushError(JSON.stringify({ error: resolved.error }));
        return;
      }
      // Find the matching folder object so we can use its fsPath as workspace root
      const folder = folders.find(f => f.name === workspace);
      if (!folder) {
        context.pushError(JSON.stringify({ error: `Workspace folder "${workspace}" not found.` }));
        return;
      }
      roots = [folder];
    } else {
      roots = [...folders];
    }

    // Call glob once per root, collecting all output chunks
    const chunks: string[] = [];
    for (const folder of roots) {
      const collected: string[] = [];
      await globTool.call({
        ...context,
        env: {
          ...context.env,
          workspace: folder.uri.fsPath,
        },
        parameters: {
          pattern,
          // When a sub-path is given, pass it so Bob scopes the search to that directory
          ...(subPath ? { path: subPath } : {}),
        },
        pushResult: (text: string) =>
          collected.push(absolutiseToolContent(text, 'glob', folder.uri.fsPath)),
        pushError:  (text: string) => context.pushError(text),
      });
      chunks.push(...collected);
    }

    if (chunks.length === 0) {
      context.pushResult('No files found');
      return;
    }
    context.pushResult(chunks.join('\n'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class GrepWorkspaceTool {
  static id = 'grep_workspace';
  groups = ['read'];
  permission = 'read';

  getId() { return GrepWorkspaceTool.id; }

  /** Only expose this tool when there are multiple workspace roots. */
  enabled(_env?: any): boolean {
    return isMultiRoot();
  }

  getDescription(_env?: any): string {
    return (
      'Search for a text pattern (regex or literal) inside files in the VS Code workspace - ' +
      'including secondary workspace folders OUTSIDE the primary workspace root. ' +
      'MUST be used instead of grep for any directory not under the primary folder. ' +
      'Returns matching lines with file path and line number, grouped by file. ' +
      'Pass a workspace folder name to scope the search to one folder, or omit to search all. ' +
      'Results are capped at 100 matching lines across all files.'
    );
  }

  getCostEffectiveDescription(): string {
    return 'Search file contents by regex in any workspace folder (use instead of grep for non-primary folders)';
  }

  private static readonly PARAMS = [
    {
      name: 'pattern',
      type: 'string',
      detail: 'Regex pattern to search for in file contents (uses Rust regex syntax).',
      required: true,
      usage: 'function handleClick',
    },
    {
      name: 'workspace',
      type: 'string',
      detail: 'Workspace folder name (from list_workspace_folders). Omit to search all folders.',
      required: false,
      usage: 'backend',
    },
    {
      name: 'path',
      type: 'string',
      detail: 'File or directory path to search in, relative to the workspace folder root. Accepts single path only. Defaults to workspace root.',
      required: false,
      usage: 'src',
    },
    {
      name: 'include',
      type: 'string',
      detail: 'Glob pattern to filter files (e.g. "*.ts", "*.{ts,tsx}").',
      required: false,
      usage: '**/*.ts',
    },
    {
      name: 'ignore_case',
      type: 'boolean',
      detail: 'Case-insensitive matching (-i).',
      required: false,
      usage: 'false',
    },
    {
      name: 'invert_match',
      type: 'boolean',
      detail: 'Return lines that do NOT match the pattern (-v).',
      required: false,
      usage: 'false',
    },
    {
      name: 'word_regexp',
      type: 'boolean',
      detail: 'Only match whole words - pattern must be surrounded by word boundaries (-w).',
      required: false,
      usage: 'false',
    },
    {
      name: 'files_with_matches',
      type: 'boolean',
      detail: 'Return only file paths instead of individual matching lines (-l). Useful for checking which files contain a pattern.',
      required: false,
      usage: 'false',
    },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(GrepWorkspaceTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] { return GrepWorkspaceTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const pat = typeof args?.pattern === 'string' && args.pattern.trim() ? ` for "${args.pattern}"` : '';
    const loc = typeof args?.path === 'string' && args.path.trim()
      ? ` in ${args.workspace ? `${args.workspace}/` : ''}${args.path}`
      : (args?.workspace ? ` in ${args.workspace}` : '');
    return {
      displayName: `Search Files${loc}${pat}`,
      running: `Searching files${loc}${pat}`,
      success: `Searched files${loc}${pat}`,
      error: `Failed to search files${loc}${pat}`,
    };
  }

  async call(context: {
    env: any;
    parameters: {
      pattern: string;
      workspace?: string;
      path?: string;
      include?: string;
      ignore_case?: boolean;
      invert_match?: boolean;
      word_regexp?: boolean;
      files_with_matches?: boolean;
    };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { pattern, workspace, path: subPath, include,
            ignore_case, invert_match, word_regexp, files_with_matches } = context.parameters;

    const grepTool = getBobTool('grep');
    if (!grepTool) {
      context.pushError('grep_workspace: grep tool not found in current task.');
      return;
    }

    // Determine which workspace roots to search
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      context.pushError(JSON.stringify({ error: 'No workspace folders are open.' }));
      return;
    }

    let roots: Array<vscode.WorkspaceFolder>;
    if (workspace) {
      const resolved = resolveInFolder(workspace, '');
      if ('error' in resolved) {
        context.pushError(JSON.stringify({ error: resolved.error }));
        return;
      }
      const folder = folders.find(f => f.name === workspace);
      if (!folder) {
        context.pushError(JSON.stringify({ error: `Workspace folder "${workspace}" not found.` }));
        return;
      }
      roots = [folder];
    } else {
      roots = [...folders];
    }

    // Call grep once per root, collecting all output chunks
    const chunks: string[] = [];
    for (const folder of roots) {
      const collected: string[] = [];
      await grepTool.call({
        ...context,
        env: {
          ...context.env,
          workspace: folder.uri.fsPath,
        },
        parameters: {
          pattern,
          ...(subPath       !== undefined && { path:               subPath }),
          ...(include       !== undefined && { include }),
          ...(ignore_case   !== undefined && { ignore_case }),
          ...(invert_match  !== undefined && { invert_match }),
          ...(word_regexp   !== undefined && { word_regexp }),
          ...(files_with_matches !== undefined && { files_with_matches }),
        },
        pushResult: (text: string) =>
          collected.push(absolutiseToolContent(text, 'grep', folder.uri.fsPath)),
        pushError:  (text: string) => context.pushError(text),
      });
      chunks.push(...collected);
    }

    if (chunks.length === 0) {
      context.pushResult('No files found');
      return;
    }
    context.pushResult(chunks.join('\n'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class WriteWorkspaceFileTool {
  static id = 'write_workspace_file';
  groups = ['edit'];
  permission = 'edit';

  getId() { return WriteWorkspaceFileTool.id; }

  /** Only expose this tool when there are multiple workspace roots. */
  enabled(_env?: any): boolean {
    return isMultiRoot();
  }

  getDescription(_env?: any): string {
    return (
      'Write (create or overwrite) a file in any folder in the VS Code workspace - ' +
      'including secondary workspace folders OUTSIDE the primary workspace root. ' +
      'MUST be used instead of write_file for any file not under the primary folder. ' +
      'If the file does not exist it is created; if it exists it is fully overwritten. ' +
      'Parent directories are created automatically. ' +
      'Call list_workspace_folders first to get the folder name, then pass it as "workspace". ' +
      'Always provide the COMPLETE intended content - this tool performs a full overwrite.'
    );
  }

  getCostEffectiveDescription(): string {
    return 'Write/create file in any workspace folder (use instead of write_file for non-primary folders)';
  }

  private static readonly PARAMS = [
    {
      name: 'workspace',
      type: 'string',
      description: 'Workspace folder name as returned by list_workspace_folders (e.g. "backend").',
      detail: 'Workspace folder name',
      required: true,
      usage: 'backend',
      renderHint: 'hidden',
    },
    {
      name: 'path',
      type: 'string',
      description: 'File path relative to the workspace folder root (e.g. "src/app.ts").',
      detail: 'File path relative to workspace folder',
      required: true,
      usage: 'src/server.ts',
      renderHint: 'hidden',
    },
    {
      name: 'content',
      type: 'string',
      description:
        'The COMPLETE content to write to the file. ' +
        'Always provide the full intended file content - do not truncate or omit any part. ' +
        'Do not include line numbers in the content.',
      detail: 'Full file content to write',
      required: true,
      renderHint: 'code',
    },
    {
      name: 'line_count',
      type: 'number',
      description: 'The number of lines you intend to write. Compute this before generating the content parameter. Used to detect truncation on large files (100+ lines).',
      detail: 'Expected line count (optional, helps detect truncation)',
      required: false,
      renderHint: 'text',
    },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(WriteWorkspaceFileTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] { return WriteWorkspaceFileTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const p = args?.path ? ` ${args.path}` : '';
    return {
      displayName: `Write File${p}`,
      running: `Writing file${p}`,
      success: `Wrote file${p}`,
      error: `Failed to write file${p}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { workspace: string; path: string; content: string; line_count?: number };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
    setMetadata?: (meta: Record<string, any>) => void;
    [key: string]: any;
  }): Promise<void> {
    const { workspace, path: filePath, content, line_count } = context.parameters;

    const resolved = resolveInFolder(workspace, '');
    if ('error' in resolved) {
      context.pushError(JSON.stringify({ error: resolved.error }));
      return;
    }

    const writeFileTool = getBobTool('write_file');
    if (!writeFileTool) {
      context.pushError('write_workspace_file: write_file tool not found in current task.');
      return;
    }

    await writeFileTool.call({
      ...context,
      env: {
        ...context.env,
        workspace: resolved.uri.fsPath,
      },
      parameters: {
        path: filePath,
        content,
        ...(line_count !== undefined && { line_count }),
      },
      // Bob's write_file calls f.pushEdit(uri, { before, after, mtime }) unconditionally.
      // Bridge it to setMetadata so the undo entry (K.changes) and mtime (K.fileMtimes)
      // are recorded in Bob's task metadata — identical to what Bob's own task runner does.
      pushEdit: (uri: string, edit: { before: string; after: string; mtime?: number }) => {
        context.setMetadata?.({
          changes: { [uri]: { before: edit.before, after: edit.after, patch: createPatch(uri, edit.before, edit.after) } },
          ...(edit.mtime !== undefined && { fileMtimes: { [uri]: edit.mtime } }),
        });
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class InsertWorkspaceContentTool {
  static id = 'insert_workspace_content';
  groups = ['edit'];
  permission = 'edit';

  getId() { return InsertWorkspaceContentTool.id; }

  enabled(_env?: any): boolean { return isMultiRoot(); }

  getDescription(_env?: any): string {
    return (
      'Add new lines of content into a file in any VS Code workspace folder without modifying ' +
      'existing content. Specify the line number to insert before, or use line 0 to append to ' +
      'the end. MUST be used instead of insert_content for files outside the primary folder. ' +
      'Ideal for adding imports, functions, configuration blocks, or any multi-line text block.'
    );
  }

  getCostEffectiveDescription(): string {
    return 'Insert lines into a file in any workspace folder without overwriting (use instead of insert_content for non-primary folders)';
  }

  private static readonly PARAMS = [
    {
      name: 'workspace',
      type: 'string',
      detail: 'Workspace folder name as returned by list_workspace_folders (e.g. "backend").',
      required: true,
      usage: 'backend',
      renderHint: 'hidden',
    },
    {
      name: 'path',
      type: 'string',
      detail: 'File path relative to the workspace folder root (e.g. "src/app.ts").',
      required: true,
      usage: 'src/server.ts',
      renderHint: 'hidden',
    },
    {
      name: 'line',
      type: 'number',
      detail: 'Line number where content will be inserted (1-based). Use 0 to append at end of file. Use any positive number to insert before that line.',
      required: true,
      renderHint: 'text',
    },
    {
      name: 'content',
      type: 'string',
      detail: 'The content to insert at the specified line.',
      required: true,
      renderHint: 'code',
    },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(InsertWorkspaceContentTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] { return InsertWorkspaceContentTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const loc = args?.path ? ` into ${args.workspace ? `${args.workspace}/` : ''}${args.path}` : '';
    return {
      displayName: `Insert Content${loc}`,
      running: `Inserting content${loc}`,
      success: `Inserted content${loc}`,
      error: `Failed to insert content${loc}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { workspace: string; path: string; line: number; content: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
    setMetadata?: (meta: Record<string, any>) => void;
    [key: string]: any;
  }): Promise<void> {
    const { workspace, path: filePath, line, content } = context.parameters;

    const resolved = resolveInFolder(workspace, '');
    if ('error' in resolved) {
      context.pushError(JSON.stringify({ error: resolved.error }));
      return;
    }

    const insertContentTool = getBobTool('insert_content');
    if (!insertContentTool) {
      context.pushError('insert_workspace_content: insert_content tool not found in current task.');
      return;
    }

    await insertContentTool.call({
      ...context,
      env: {
        ...context.env,
        workspace: resolved.uri.fsPath,
      },
      parameters: { path: filePath, line, content },
      pushEdit: (uri: string, edit: { before: string; after: string; mtime?: number }) => {
        context.setMetadata?.({
          changes: { [uri]: { before: edit.before, after: edit.after, patch: createPatch(uri, edit.before, edit.after) } },
          ...(edit.mtime !== undefined && { fileMtimes: { [uri]: edit.mtime } }),
        });
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class SearchAndReplaceWorkspaceTool {
  static id = 'search_and_replace_workspace';
  groups = ['edit'];
  permission = 'edit';

  getId() { return SearchAndReplaceWorkspaceTool.id; }

  enabled(_env?: any): boolean { return isMultiRoot(); }

  getDescription(_env?: any): string {
    return (
      'Find and replace specific text strings or patterns (using regex) within a file in any ' +
      'VS Code workspace folder. Supports literal text and regex patterns, case sensitivity ' +
      'options, and optional line ranges. MUST be used instead of search_and_replace for files ' +
      'outside the primary folder.\n\n' +
      'Notes:\n' +
      '- When use_regex is true, the search parameter is treated as a regular expression pattern\n' +
      '- When ignore_case is true, the search is case-insensitive regardless of regex mode'
    );
  }

  getCostEffectiveDescription(): string {
    return 'Find and replace text in a file in any workspace folder (use instead of search_and_replace for non-primary folders)';
  }

  private static readonly PARAMS = [
    {
      name: 'workspace',
      type: 'string',
      detail: 'Workspace folder name as returned by list_workspace_folders (e.g. "backend").',
      required: true,
      usage: 'backend',
      renderHint: 'hidden',
    },
    {
      name: 'path',
      type: 'string',
      detail: 'File path relative to the workspace folder root.',
      required: true,
      usage: 'src/server.ts',
      renderHint: 'hidden',
    },
    {
      name: 'search',
      type: 'string',
      detail: 'The text or pattern to search for.',
      required: true,
    },
    {
      name: 'replace',
      type: 'string',
      detail: 'The text to replace matches with.',
      required: true,
    },
    {
      name: 'start_line',
      type: 'number',
      detail: 'Starting line number for restricted replacement (1-based).',
      required: false,
    },
    {
      name: 'end_line',
      type: 'number',
      detail: 'Ending line number for restricted replacement (1-based).',
      required: false,
    },
    {
      name: 'use_regex',
      type: 'string',
      detail: 'Set to "true" to treat search as a regex pattern (default: false).',
      required: false,
    },
    {
      name: 'ignore_case',
      type: 'string',
      detail: 'Set to "true" to ignore case when matching (default: false).',
      required: false,
    },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(SearchAndReplaceWorkspaceTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] { return SearchAndReplaceWorkspaceTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const loc = args?.path ? ` in ${args.workspace ? `${args.workspace}/` : ''}${args.path}` : '';
    return {
      displayName: `Search & Replace${loc}`,
      running: `Searching and replacing${loc}`,
      success: `Completed search and replace${loc}`,
      error: `Failed to search and replace${loc}`,
    };
  }

  async call(context: {
    env: any;
    parameters: {
      workspace: string;
      path: string;
      search: string;
      replace: string;
      start_line?: number;
      end_line?: number;
      use_regex?: string;
      ignore_case?: string;
    };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
    setMetadata?: (meta: Record<string, any>) => void;
    [key: string]: any;
  }): Promise<void> {
    const { workspace, path: filePath, search, replace,
            start_line, end_line, use_regex, ignore_case } = context.parameters;

    const resolved = resolveInFolder(workspace, '');
    if ('error' in resolved) {
      context.pushError(JSON.stringify({ error: resolved.error }));
      return;
    }

    const searchAndReplaceTool = getBobTool('search_and_replace');
    if (!searchAndReplaceTool) {
      context.pushError('search_and_replace_workspace: search_and_replace tool not found in current task.');
      return;
    }

    await searchAndReplaceTool.call({
      ...context,
      env: {
        ...context.env,
        workspace: resolved.uri.fsPath,
      },
      parameters: {
        path: filePath,
        search,
        replace,
        ...(start_line  !== undefined && { start_line }),
        ...(end_line    !== undefined && { end_line }),
        ...(use_regex   !== undefined && { use_regex }),
        ...(ignore_case !== undefined && { ignore_case }),
      },
      pushEdit: (uri: string, edit: { before: string; after: string; mtime?: number }) => {
        context.setMetadata?.({
          changes: { [uri]: { before: edit.before, after: edit.after, patch: createPatch(uri, edit.before, edit.after) } },
          ...(edit.mtime !== undefined && { fileMtimes: { [uri]: edit.mtime } }),
        });
      },
    });
  }
}

// ─── apply_diff_workspace ─────────────────────────────────────────────────────

export class ApplyDiffWorkspaceTool {
  static id = 'apply_diff_workspace';
  groups = ['edit'];
  permission = 'edit';

  getId() { return ApplyDiffWorkspaceTool.id; }

  enabled(_env?: any): boolean { return isMultiRoot(); }

  getDescription(_env?: any): string {
    return (
      'Apply SEARCH/REPLACE diff blocks to a file in any VS Code workspace folder. ' +
      'Works identically to apply_diff but accepts a "workspace" parameter to target ' +
      'secondary workspace roots that apply_diff cannot reach. ' +
      'Requires at least one Bob turn to have completed so the diff engine is loaded.'
    );
  }

  getCostEffectiveDescription(): string {
    return 'Apply diff blocks to any workspace folder file (replaces apply_diff for non-primary folders)';
  }

  private static readonly PARAMS = [
    {
      name: 'workspace',
      type: 'string',
      detail: 'Workspace folder name as returned by list_workspace_folders (e.g. "backend").',
      required: true,
      usage: 'backend',
      renderHint: 'hidden',
    },
    {
      name: 'path',
      type: 'string',
      detail: 'File path relative to the workspace folder root (e.g. "src/app.ts").',
      required: true,
      usage: 'src/server.ts',
      renderHint: 'hidden',
    },
    {
      name: 'diff',
      type: 'string',
      detail: 'The search/replace block defining the changes.',
      required: true,
      renderHint: 'diff',
    },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(ApplyDiffWorkspaceTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] { return ApplyDiffWorkspaceTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const loc = args?.path ? ` to ${args.workspace ? `${args.workspace}/` : ''}${args.path}` : '';
    return {
      displayName: `Apply Diff${loc}`,
      running:     `Applying diff${loc}`,
      success:     `Applied diff${loc}`,
      error:       `Failed to apply diff${loc}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { workspace: string; path: string; diff: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
    setMetadata?: (meta: Record<string, any>) => void;
    [key: string]: any;
  }): Promise<void> {
    const { workspace, path: filePath, diff } = context.parameters;

    const resolved = resolveInFolder(workspace, '');
    if ('error' in resolved) {
      context.pushError(resolved.error);
      return;
    }

    const applyDiffTool = getBobTool('apply_diff');
    if (!applyDiffTool) {
      context.pushError(
        'apply_diff_workspace: apply_diff tool not found in current task.'
      );
      return;
    }

    await applyDiffTool.call({
      ...context,
      env: {
        ...context.env,
        workspace: resolved.uri.fsPath,
      },
      parameters: { path: filePath, diff },
      pushEdit: (uri: string, edit: { before: string; after: string; mtime?: number }) => {
        context.setMetadata?.({
          changes: { [uri]: { before: edit.before, after: edit.after, patch: createPatch(uri, edit.before, edit.after) } },
          ...(edit.mtime !== undefined && { fileMtimes: { [uri]: edit.mtime } }),
        });
      },
    });
  }
}

// ─── Execute workspace command ────────────────────────────────────────────────

/**
 * Execute a CLI command with its working directory resolved against a named
 * workspace folder instead of Bob's primary workspace root.
 *
 * This is a thin wrapper that delegates entirely to Bob's built-in
 * execute_command tool — it resolves the workspace folder to an absolute
 * fsPath, then calls execute_command with that path as `cwd`.  Because the
 * resolution happens here (inside the extension-host process), Bob's
 * isOutsideWorkspace check is never triggered.
 *
 * To stay in sync with execute_command automatically the `call()` method
 * never reimplements shell execution — it just forwards to the built-in.
 */
export class ExecuteWorkspaceCommandTool {
  static id = 'execute_workspace_command';
  groups = ['execute'];
  permission = 'execute';

  getId() { return ExecuteWorkspaceCommandTool.id; }

  enabled(_env?: any): boolean { return isMultiRoot(); }

  getDescription(_env?: any): string {
    return [
      'Execute a CLI command with its working directory set to a specific workspace folder.',
      'IMPORTANT: You MUST use this tool instead of execute_command whenever the target',
      'directory is in a secondary workspace folder (not the primary one). Using',
      'execute_command for a secondary folder will be blocked by the sandbox — always use',
      'this tool for those folders.',
      '',
      'All execute_command semantics apply: PowerShell on Windows, bash/sh on macOS/Linux,',
      'the cwd defaults to the workspace folder root, and timeout_seconds is optional.',
      '',
      'WORKFLOW: call list_workspace_folders → copy the folder "name" → pass it as',
      '"workspace". The "cwd" parameter is RELATIVE to that workspace folder root.',
    ].join('\n');
  }

  getCostEffectiveDescription(): string {
    return 'Execute a shell command in a secondary workspace folder (replaces execute_command for non-primary folders)';
  }

  private static readonly PARAMS = [
    {
      name: 'workspace',
      type: 'string',
      description: 'Workspace folder name as returned by list_workspace_folders (e.g. "backend").',
      detail: 'Workspace folder name',
      required: true,
      usage: 'backend',
      renderHint: 'hidden',
    },
    {
      name: 'command',
      type: 'string',
      description: 'The CLI command to execute.',
      detail: 'The CLI command to execute',
      required: true,
      usage: 'command',
      renderHint: 'code',
    },
    {
      name: 'cwd',
      type: 'string',
      description: 'Working directory relative to the workspace folder root. Omit to use the folder root itself.',
      detail: 'Working directory relative to workspace folder root (optional)',
      required: false,
      usage: 'src',
    },
    {
      name: 'timeout_seconds',
      type: 'number',
      description: 'Override the default 300s timeout. Must be the minimum needed; maximum 1800s.',
      detail: 'Timeout override in seconds (optional)',
      required: false,
    },
  ];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(ExecuteWorkspaceCommandTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] { return ExecuteWorkspaceCommandTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    return {
      displayName: `Execute Workspace Command: ${args.workspace ?? ''}`,
      running: `Running in ${args.workspace ?? ''}…`,
      success: `Command completed in ${args.workspace ?? ''}`,
      error: `Command failed in ${args.workspace ?? ''}`,
    };
  }

  async call(context: {
    env: any;
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
    log?: (...args: any[]) => void;
  }): Promise<void> {
    const { workspace, command, cwd, timeout_seconds } = context.parameters;

    // Resolve the workspace folder to an absolute fsPath
    const cwdArg = (cwd && cwd !== '.') ? cwd : '';
    const resolved = resolveInFolder(workspace, cwdArg);
    if ('error' in resolved) {
      context.pushError(resolved.error);
      return;
    }

    const absoluteCwd = resolved.uri.fsPath;

    // Delegate to Bob's built-in execute_command.
    // We pass an absolute cwd which is valid — Bob only blocks relative paths
    // that escape the primary workspace; an absolute path it accepts directly.
    // The only thing we cannot reuse is execute_command's internal call() since
    // it is inside the closed Bob bundle, so we call the registered tool instead.
    const executeCommandTool = getBobTool('execute_command');
    if (!executeCommandTool) {
      context.pushError(
        'execute_workspace_command: execute_command tool not found in current task.'
      );
      return;
    }

    // Build a forwarded context that patches env.workspace to the resolved folder
    // so execute_command's cwd computation is anchored correctly.
    const forwardedContext = {
      ...context,
      env: {
        ...context.env,
        workspace: absoluteCwd,
      },
      parameters: {
        command,
        // cwd is not passed — execute_command defaults to env.workspace (now absoluteCwd)
        ...(timeout_seconds !== undefined && { timeout_seconds }),
      },
    };

    await executeCommandTool.call(forwardedContext);
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register all workspace tools with Bob's source registry.
 * These tools use vscode.workspace.fs directly, so they bypass Bob's
 * single-root sandbox and never trigger "outside workspace" confirmation prompts.
 *
 * Tools registered (10):
 *   list_workspace_folders        - discover all workspace roots
 *   read_workspace_file           - read any file (replaces read_file)
 *   write_workspace_file          - write/create any file (replaces write_file)
 *   list_workspace_files          - browse any directory (replaces list_files)
 *   glob_workspace                - find files by glob (replaces glob)
 *   grep_workspace                - search file contents (replaces grep)
 *   insert_workspace_content      - insert lines without overwriting (replaces insert_content)
 *   search_and_replace_workspace  - find/replace in file (replaces search_and_replace)
 *   apply_diff_workspace          - apply diff blocks (replaces apply_diff)
 *   execute_workspace_command     - run a command in any workspace folder (replaces execute_command)
 */
export function registerWorkspaceTools(source: any) {
  source.registerTool(new ListWorkspaceFoldersTool());
  source.registerTool(new ReadWorkspaceFileTool());
  source.registerTool(new WriteWorkspaceFileTool());
  source.registerTool(new ListWorkspaceFilesTool());
  source.registerTool(new GlobWorkspaceTool());
  source.registerTool(new GrepWorkspaceTool());
  source.registerTool(new InsertWorkspaceContentTool());
  source.registerTool(new SearchAndReplaceWorkspaceTool());
  source.registerTool(new ApplyDiffWorkspaceTool());
  source.registerTool(new ExecuteWorkspaceCommandTool());
  registerWorkspacePromptInjection(source);
}

/**
 * Inject multi-root workspace context into the system prompt on the first turn
 * of every task.
 *
 * onTurnStart fires before the system message exists - Bob builds it during
 * submitTurn, which runs after this callback returns. We poll with setTimeout(0)
 * until messages[0] with role === 'system' appears, then append our block.
 * Polling stops after MAX_POLLS attempts (~500 ms total) to avoid leaking.
 */
function registerWorkspacePromptInjection(source: any) {
  source.onTurnStart((taskId: string, _envs: any, isEmpty: boolean) => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!isEmpty || folders.length < 2) { return; }

    const injection = buildInjection(folders);

    const MAX_POLLS = 50;
    const POLL_MS   = 10;
    let   attempts  = 0;

    function tryInject() {
      try {
        const tm = getTaskManager();
        if (!tm) { return; }

        const cm = findTaskChatManager(tm, taskId);
        if (!cm) { return; }

        const task = cm.currentTask;
        if (!task) { return; }

        const messages = task.getMessages?.();
        const systemMessage = messages?.[0];

        if (!systemMessage || systemMessage.role !== 'system') {
          // System message not yet written - retry
          if (++attempts < MAX_POLLS) { setTimeout(tryInject, POLL_MS); }
          return;
        }

        systemMessage.content += injection;
      } catch {
        // Non-fatal - tools still work without the injection
      }
    }

    setTimeout(tryInject, 0);
  });
}

function buildInjection(folders: readonly vscode.WorkspaceFolder[]): string {
  const lines = folders.map(f => `  - name="${f.name}"  fsPath="${f.uri.fsPath}"`);
  return [
    '',
    '<multi_root_workspace>',
    `This is a multi-root workspace with ${folders.length} root folders:`,
    ...lines,
    '',
    `The PRIMARY folder (used by built-in tools) is: ${folders[0].uri.fsPath}`,
    'IMPORTANT: Built-in tools (read_file, write_file, list_files, glob, grep,',
    'insert_content, search_and_replace, execute_command) are SANDBOXED to the primary',
    'folder and will be BLOCKED for all other folders.', 
    '',
    'You MUST use the workspace-specific tools for any secondary folder:',
    '  read_workspace_file           - replaces read_file',
    '  write_workspace_file          - replaces write_file',
    '  list_workspace_files          - replaces list_files',
    '  glob_workspace                - replaces glob',
    '  grep_workspace                - replaces grep',
    '  insert_workspace_content      - replaces insert_content',
    '  search_and_replace_workspace  - replaces search_and_replace',
    '  apply_diff_workspace          - replaces apply_diff',
    '  execute_workspace_command     - replaces execute_command',
    '',
    'WORKFLOW: call list_workspace_folders → copy the folder "name" → pass it as the',
    '"workspace" parameter to the tool above.',
    'The "path"/"cwd" parameter on those tools is always RELATIVE to the workspace folder root.',
    '</multi_root_workspace>',
  ].join('\n');
}

/**
 * Remap workspace tool names so Bob's webview renderer applies the same rich
 * UI (CodeBlock, FileListBlock, GrepResultBlock) that it uses for the built-in
 * equivalents.
 *
 * The renderer in chat-*.js keys off `toolUsage.signature.name` inside the
 * messages array of a `{ type: "setMessages" }` postMessage.  Our workspace
 * tools have different names, so without this patch they fall through to the
 * plain MarkdownBlock path.
 *
 * Approach:
 *   1. For every chatManager in _chatManagers, wrap cm.ui.setWebview() so that
 *      each time a webview is assigned we immediately patch view.sendMessage()
 *      on that webview instance.
 *   2. The sendMessage patch intercepts { type: "setMessages" } and remaps
 *      toolUsage.signature.name in each message's toolUsage.
 *   3. Patch _chatManagers.push() to apply the same treatment to future
 *      chatManagers.
 *
 * Called once from completeRegisterPowerToys(), after registerTaskManager()
 * has populated _cachedTaskManager.
 */
export function registerWebviewToolNamePatch(): void {
  const NAME_MAP: Record<string, string> = {
    read_workspace_file:  'read_file',
    list_workspace_files: 'list_files',
    glob_workspace:       'glob',
    grep_workspace:       'grep',
  };

  const tm = getTaskManager();
  if (!tm) { return; }

  const chatManagers: any[] = tm._chatManagers ?? [];

  /** Patch sendMessage (outbound) and onMessage (inbound) on a single webview instance. */
  function patchView(view: any): void {
    if (!view || view.__bobPtPatchedSendMessage) { return; }

    // ── outbound: remap tool names so the renderer uses rich UI components ──
    const originalSend = view.sendMessage.bind(view);
    view.sendMessage = (message: any) => {
      if (message?.type === 'setMessages' && Array.isArray(message.messages)) {
        let changed = false;
        const newMessages = message.messages.map((msg: any) => {
          const name: string | undefined = msg?.toolUsage?.signature?.name;
          const mapped = name && NAME_MAP[name];
          if (!mapped) { return msg; }
          changed = true;
          return {
            ...msg,
            toolUsage: {
              ...msg.toolUsage,
              signature: { ...msg.toolUsage.signature, name: mapped },
            },
          };
        });
        if (changed) {
          message = { ...message, messages: newMessages };
        }
      }
      return originalSend(message);
    };

    // ── inbound: fix openFile paths for secondary workspace folders ──
    // Bob's handler resolves relative paths against the primary workspace root.
    // If the path starts with a known folder name (e.g. "process-discovery/src/…")
    // we rewrite it to the absolute path before Bob's handler sees it.
    //
    // wrapHandler wraps a single handler function; we use it for both the
    // already-registered handler and any future registration via onMessage.
    if (view.handlers?.openFile) {
      view.handlers.openFile = wrapHandler(view.handlers.openFile);
    }
    const originalOnMessage = view.onMessage.bind(view);
    view.onMessage = (type: string, handler: (msg: any) => any) => {
      return originalOnMessage(type, type === 'openFile' ? wrapHandler(handler) : handler);
    };

    view.__bobPtPatchedSendMessage = true;
  }

  /** Returns a wrapped version of an openFile handler that resolves secondary paths. */
  function wrapHandler(handler: (msg: any) => any): (msg: any) => any {
    if ((handler as any).__bobPtWrapped) { return handler; }
    const wrapped = (msg: any) => {
      const fixed = typeof msg?.filePath === 'string'
        ? resolveOpenFilePath(msg.filePath, vscode.workspace.workspaceFolders ?? []) : msg?.filePath;
      return handler(fixed !== msg?.filePath ? { ...msg, filePath: fixed } : msg);
    };
    (wrapped as any).__bobPtWrapped = true;
    return wrapped;
  }

  /**
   * Wrap cm.ui.setWebview so every time a view is (re-)assigned we patch it.
   * Also patch the current view if one already exists.
   */
  function patchChatManager(cm: any): void {
    if (!cm?.ui || cm.__bobPtPatchedCm) { return; }
    cm.__bobPtPatchedCm = true;

    // Patch the view that may already be set
    if (cm.view) { patchView(cm.view); }

    // Intercept future setWebview calls on the ui object
    const ui = cm.ui;
    const originalSetWebview = ui.setWebview?.bind(ui);
    if (originalSetWebview) {
      ui.setWebview = (webview: any) => {
        if (webview) { patchView(webview); }
        originalSetWebview(webview);
      };
    }
  }

  // Patch all chatManagers that exist now
  for (const cm of chatManagers) {
    patchChatManager(cm);
  }

  // Patch future chatManagers by intercepting push() on the live array
  if (Array.isArray(chatManagers)) {
    const originalPush = chatManagers.push.bind(chatManagers);
    chatManagers.push = (...items: any[]) => {
      for (const item of items) { patchChatManager(item); }
      return originalPush(...items);
    };
  }
}
