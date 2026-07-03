/**
 * Workspace tools — bypass Bob's single-root sandbox so Bob can read any file
 * from any folder in a multi-root VS Code workspace without per-file confirmation.
 *
 * Root cause: Bob's built-in read_file / list_files / grep / glob tools pass
 * only the primary workspace folder to `isOutsideWorkspace()`, so every file in
 * a second or third workspace root triggers the "allow outside workspace?" prompt.
 *
 * These tools use `vscode.workspace.fs` directly from the extension-host process,
 * which has no such sandbox — all workspace folders are treated equally.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getTaskManager, findTaskChatManager } from '../utils.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

  const rel = filePath.replace(/\\/g, '/').replace(/^\.?\/?/, '');
  const uri = rel ? vscode.Uri.joinPath(folder.uri, rel) : folder.uri;
  return { uri };
}

/**
 * Recursively collect files/dirs up to `cap` entries.
 */
async function readDirRecursive(
  uri: vscode.Uri,
  base: string,
  results: Array<{ path: string; type: string }>,
  cap: number
): Promise<void> {
  if (results.length >= cap) { return; }
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return;
  }
  for (const [name, type] of entries) {
    if (results.length >= cap) { break; }
    const rel = base ? `${base}/${name}` : name;
    const entryType = type === vscode.FileType.Directory ? 'directory' : 'file';
    results.push({ path: rel, type: entryType });
    if (type === vscode.FileType.Directory) {
      await readDirRecursive(vscode.Uri.joinPath(uri, name), rel, results, cap);
    }
  }
}

/**
 * Minimal glob-style matching: supports * (any chars except /) and ** (any path).
 * Used by search_workspace_files and grep_workspace.
 */
function matchGlob(pattern: string, filePath: string): boolean {
  // Normalise separators
  const p = filePath.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');

  // Convert glob to regex
  const regexStr = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars (not * or ?)
    .replace(/\*\*/g, '\x00')              // placeholder for **
    .replace(/\*/g, '[^/]*')               // * → any chars except /
    .replace(/\x00/g, '.*')               // ** → any chars including /
    .replace(/\?/g, '[^/]');              // ? → single char except /

  const regex = new RegExp(`^${regexStr}$`, 'i');
  // Match against full path or just filename
  return regex.test(p) || regex.test(path.basename(p));
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
      'PRIMARY folder shown in environment_info — they will be blocked for all others. ' +
      'ALWAYS call this first on any task that might touch more than one project. ' +
      'Then pass the folder\'s "name" as the "workspace" parameter to ' +
      'read_workspace_file / write_workspace_file / list_workspace_files / ' +
      'search_workspace_files / grep_workspace.'
    );
  }

  getCostEffectiveDescription(): string {
    return 'List all VS Code workspace folder roots — call first, then use folder name as "workspace" param';
  }

  private static readonly PARAMS: any[] = [];
  parameters = ListWorkspaceFoldersTool.PARAMS;
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
      note: 'Pass the folder "name" as the "workspace" parameter to read_workspace_file / write_workspace_file / list_workspace_files / search_workspace_files / grep_workspace.',
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
      'Read the text content of any file in the VS Code workspace — including files in ' +
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
      description: 'Optional line range to return, format "start-end" (1-based, inclusive). E.g. "10-50". Omit to return the full file.',
      detail: 'Line range "start-end" (optional)',
      required: false,
      usage: '1-100',
    },
  ];

  parameters = ReadWorkspaceFileTool.PARAMS;
  getParameters(_env?: any): any[] { return ReadWorkspaceFileTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const p = args?.path ?? '';
    return {
      displayName: `Read: ${path.basename(p)}`,
      running: `Reading ${args?.workspace ?? ''}/${p}...`,
      success: `Read ${p}`,
      error: `Failed to read ${p}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { workspace: string; path: string; range?: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { workspace, path: filePath, range } = context.parameters;

    const resolved = resolveInFolder(workspace, filePath);
    if ('error' in resolved) {
      context.pushError(JSON.stringify({ error: resolved.error }));
      return;
    }
    const { uri } = resolved;

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (err) {
      context.pushError(JSON.stringify({
        error: `Cannot read file: ${filePath}`,
        resolvedPath: uri.fsPath,
        message: err instanceof Error ? err.message : String(err),
      }, null, 2));
      return;
    }

    const fullText = Buffer.from(bytes).toString('utf8');
    const allLines = fullText.split('\n');

    let startLine = 1;
    let endLine = allLines.length;

    if (range) {
      const m = /^(\d+)-(\d+)$/.exec(range.trim());
      if (!m) {
        context.pushError(JSON.stringify({ error: `Invalid range "${range}". Expected format: "start-end" e.g. "10-50".` }));
        return;
      }
      startLine = Math.max(1, parseInt(m[1], 10));
      endLine = Math.min(allLines.length, parseInt(m[2], 10));
    }

    // Build numbered output (same style as Bob's built-in read_file)
    const slice = allLines.slice(startLine - 1, endLine);
    const numbered = slice.map((line, i) => `${startLine + i} | ${line}`).join('\n');

    context.pushResult(JSON.stringify({
      path: filePath,
      resolvedPath: uri.fsPath,
      totalLines: allLines.length,
      returnedLines: { start: startLine, end: endLine },
      content: numbered,
    }, null, 2));
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
      'List files and directories inside any folder in the VS Code workspace — including ' +
      'secondary workspace folders OUTSIDE the primary workspace root. ' +
      'MUST be used instead of list_files for any directory not under the primary folder. ' +
      'Call list_workspace_folders first to get the folder name, then pass it as "workspace". ' +
      'Use recursive:true to walk the full subtree (capped at 500 entries).'
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
      description: 'If true, list files recursively. Defaults to false (top-level only). Recursive listings are capped at 500 entries.',
      detail: 'List recursively (default: false)',
      required: false,
      usage: 'false',
    },
  ];

  parameters = ListWorkspaceFilesTool.PARAMS;
  getParameters(_env?: any): any[] { return ListWorkspaceFilesTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const p = args?.path ? `/${args.path}` : '';
    return {
      displayName: `List: ${args?.workspace ?? ''}${p}`,
      running: `Listing ${args?.workspace ?? ''}${p}...`,
      success: `Listed ${args?.workspace ?? ''}${p}`,
      error: `Failed to list ${args?.workspace ?? ''}${p}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { workspace: string; path?: string; recursive?: boolean };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { workspace, path: dirPath = '', recursive = false } = context.parameters;
    const RECURSIVE_CAP = 500;

    const resolved = resolveInFolder(workspace, dirPath);
    if ('error' in resolved) {
      context.pushError(JSON.stringify({ error: resolved.error }));
      return;
    }
    const { uri } = resolved;

    if (!recursive) {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(uri);
      } catch (err) {
        context.pushError(JSON.stringify({
          error: `Cannot list directory: ${dirPath}`,
          resolvedPath: uri.fsPath,
          message: err instanceof Error ? err.message : String(err),
        }, null, 2));
        return;
      }

      const items = entries.map(([name, type]) => ({
        name,
        type: type === vscode.FileType.Directory ? 'directory' : 'file',
      }));

      context.pushResult(JSON.stringify({
        workspace,
        path: dirPath || '.',
        resolvedPath: uri.fsPath,
        totalEntries: items.length,
        entries: items,
      }, null, 2));
    } else {
      const results: Array<{ path: string; type: string }> = [];
      await readDirRecursive(uri, '', results, RECURSIVE_CAP);

      context.pushResult(JSON.stringify({
        workspace,
        path: dirPath || '.',
        resolvedPath: uri.fsPath,
        totalEntries: results.length,
        capped: results.length >= RECURSIVE_CAP,
        entries: results,
      }, null, 2));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class SearchWorkspaceFilesTool {
  static id = 'search_workspace_files';
  groups = ['read'];
  permission = 'read';

  getId() { return SearchWorkspaceFilesTool.id; }

  /** Only expose this tool when there are multiple workspace roots. */
  enabled(_env?: any): boolean {
    return isMultiRoot();
  }

  getDescription(_env?: any): string {
    return (
      'Find files by name pattern (glob) inside any folder in the VS Code workspace — ' +
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
      description: 'Glob pattern to match against file paths relative to the workspace folder root. Examples: "**/*.ts", "src/**/*.test.ts", "*.json".',
      detail: 'Glob pattern e.g. "**/*.ts"',
      required: true,
      usage: '**/*.ts',
    },
    {
      name: 'workspace',
      type: 'string',
      description: 'Workspace folder name as returned by list_workspace_folders. Omit to search all workspace folders.',
      detail: 'Workspace folder name (optional, defaults to all folders)',
      required: false,
      usage: 'backend',
    },
    {
      name: 'path',
      type: 'string',
      description: 'Subdirectory within the workspace folder to restrict the search. Omit to search from the folder root.',
      detail: 'Subdirectory path within workspace folder (optional)',
      required: false,
      usage: 'src',
    },
  ];

  parameters = SearchWorkspaceFilesTool.PARAMS;
  getParameters(_env?: any): any[] { return SearchWorkspaceFilesTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const pat = args?.pattern ?? '';
    const loc = args?.workspace ? ` in ${args.workspace}${args.path ? `/${args.path}` : ''}` : '';
    return {
      displayName: `Glob: ${pat}${loc}`,
      running: `Searching for ${pat}...`,
      success: `Found files matching ${pat}`,
      error: `Failed to search for ${pat}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { pattern: string; workspace?: string; path?: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { pattern, workspace, path: subPath } = context.parameters;
    const CAP = 200;

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      context.pushError(JSON.stringify({ error: 'No workspace folders are open.' }));
      return;
    }

    let roots: Array<{ uri: vscode.Uri; label: string }>;
    if (workspace) {
      const resolved = resolveInFolder(workspace, subPath ?? '');
      if ('error' in resolved) {
        context.pushError(JSON.stringify({ error: resolved.error }));
        return;
      }
      roots = [{ uri: resolved.uri, label: subPath ? `${workspace}/${subPath}` : workspace }];
    } else {
      roots = folders.map(f => ({ uri: f.uri, label: f.name }));
    }

    const matches: Array<{ folder: string; path: string; fullPath: string }> = [];

    for (const root of roots) {
      if (matches.length >= CAP) { break; }
      const all: Array<{ path: string; type: string }> = [];
      await readDirRecursive(root.uri, '', all, CAP - matches.length + 100);

      for (const entry of all) {
        if (entry.type !== 'file') { continue; }
        if (matchGlob(pattern, entry.path)) {
          matches.push({
            folder: root.label,
            path: entry.path,
            fullPath: vscode.Uri.joinPath(root.uri, entry.path).fsPath,
          });
          if (matches.length >= CAP) { break; }
        }
      }
    }

    context.pushResult(JSON.stringify({
      pattern,
      searchRoot: workspace ? (subPath ? `${workspace}/${subPath}` : workspace) : '(all workspace folders)',
      totalMatches: matches.length,
      capped: matches.length >= CAP,
      matches,
    }, null, 2));
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
      'Search for a text pattern (regex or literal) inside files in the VS Code workspace — ' +
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
      description: 'Text or regex pattern to search for inside file contents. Use plain text for literal search, or a JavaScript regex pattern.',
      detail: 'Search pattern (text or regex)',
      required: true,
      usage: 'function handleClick',
    },
    {
      name: 'workspace',
      type: 'string',
      description: 'Workspace folder name as returned by list_workspace_folders. Omit to search all workspace folders.',
      detail: 'Workspace folder name (optional, defaults to all folders)',
      required: false,
      usage: 'backend',
    },
    {
      name: 'path',
      type: 'string',
      description: 'Subdirectory within the workspace folder to restrict the search. Omit to search from the folder root.',
      detail: 'Subdirectory path within workspace folder (optional)',
      required: false,
      usage: 'src',
    },
    {
      name: 'include',
      type: 'string',
      description: 'Glob pattern to filter which files are searched. E.g. "**/*.ts" to only search TypeScript files. Omit to search all files.',
      detail: 'File filter glob pattern (optional)',
      required: false,
      usage: '**/*.ts',
    },
    {
      name: 'ignore_case',
      type: 'boolean',
      description: 'If true, perform case-insensitive matching. Defaults to false.',
      detail: 'Case-insensitive (default: false)',
      required: false,
      usage: 'false',
    },
  ];

  parameters = GrepWorkspaceTool.PARAMS;
  getParameters(_env?: any): any[] { return GrepWorkspaceTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const pat = args?.pattern ?? '';
    const loc = args?.workspace ? ` in ${args.workspace}${args.path ? `/${args.path}` : ''}` : '';
    return {
      displayName: `Grep: ${pat}${loc}`,
      running: `Searching for "${pat}"...`,
      success: `Searched for "${pat}"`,
      error: `Failed to search for "${pat}"`,
    };
  }

  async call(context: {
    env: any;
    parameters: { pattern: string; workspace?: string; path?: string; include?: string; ignore_case?: boolean };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { pattern, workspace, path: subPath, include: includeGlob, ignore_case = false } = context.parameters;
    const LINE_CAP = 100;
    const FILE_CAP = 500;

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      context.pushError(JSON.stringify({ error: 'No workspace folders are open.' }));
      return;
    }

    // Build regex
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignore_case ? 'i' : '');
    } catch {
      // Fall back to literal match
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, ignore_case ? 'i' : '');
    }

    // Determine roots
    let roots: Array<{ uri: vscode.Uri; label: string }>;
    if (workspace) {
      const resolved = resolveInFolder(workspace, subPath ?? '');
      if ('error' in resolved) {
        context.pushError(JSON.stringify({ error: resolved.error }));
        return;
      }
      roots = [{ uri: resolved.uri, label: subPath ? `${workspace}/${subPath}` : workspace }];
    } else {
      roots = folders.map(f => ({ uri: f.uri, label: f.name }));
    }

    interface LineMatch { line: number; text: string; }
    interface FileResult { folder: string; path: string; fullPath: string; matches: LineMatch[]; }
    const results: FileResult[] = [];
    let totalLines = 0;

    outer:
    for (const root of roots) {
      const all: Array<{ path: string; type: string }> = [];
      await readDirRecursive(root.uri, '', all, FILE_CAP);

      for (const entry of all) {
        if (entry.type !== 'file') { continue; }
        if (includeGlob && !matchGlob(includeGlob, entry.path)) { continue; }

        const fileUri = vscode.Uri.joinPath(root.uri, entry.path);
        let text: string;
        try {
          const bytes = await vscode.workspace.fs.readFile(fileUri);
          text = Buffer.from(bytes).toString('utf8');
        } catch {
          continue;
        }

        const lines = text.split('\n');
        const fileMatches: LineMatch[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            fileMatches.push({ line: i + 1, text: lines[i].trimEnd() });
            totalLines++;
            if (totalLines >= LINE_CAP) {
              if (fileMatches.length > 0) {
                results.push({
                  folder: root.label,
                  path: entry.path,
                  fullPath: fileUri.fsPath,
                  matches: fileMatches,
                });
              }
              break outer;
            }
          }
        }

        if (fileMatches.length > 0) {
          results.push({
            folder: root.label,
            path: entry.path,
            fullPath: fileUri.fsPath,
            matches: fileMatches,
          });
        }
      }
    }

    context.pushResult(JSON.stringify({
      pattern,
      searchRoot: workspace ? (subPath ? `${workspace}/${subPath}` : workspace) : '(all workspace folders)',
      includeFilter: includeGlob ?? '(all files)',
      totalMatchingLines: totalLines,
      capped: totalLines >= LINE_CAP,
      files: results,
    }, null, 2));
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
      'Write (create or overwrite) a file in any folder in the VS Code workspace — ' +
      'including secondary workspace folders OUTSIDE the primary workspace root. ' +
      'MUST be used instead of write_file for any file not under the primary folder. ' +
      'If the file does not exist it is created; if it exists it is fully overwritten. ' +
      'Parent directories are created automatically. ' +
      'Call list_workspace_folders first to get the folder name, then pass it as "workspace". ' +
      'Always provide the COMPLETE intended content — this tool performs a full overwrite.'
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
        'Always provide the full intended file content — do not truncate or omit any part. ' +
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

  parameters = WriteWorkspaceFileTool.PARAMS;
  getParameters(_env?: any): any[] { return WriteWorkspaceFileTool.PARAMS; }

  getLabels(args: Record<string, any>) {
    const p = args?.path ?? '';
    return {
      displayName: `Write: ${path.basename(p)}`,
      running: `Writing ${p}...`,
      success: `Wrote ${p}`,
      error: `Failed to write ${p}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { workspace: string; path: string; content: string; line_count?: number };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { workspace, path: filePath, content, line_count } = context.parameters;

    const resolved = resolveInFolder(workspace, filePath);
    if ('error' in resolved) {
      context.pushError(JSON.stringify({ error: resolved.error }));
      return;
    }
    const { uri } = resolved;

    // Optional truncation check
    if (line_count !== undefined) {
      const actualLines = content.split('\n').length;
      if (actualLines < line_count * 0.8) {
        context.pushError(JSON.stringify({
          error: `Content truncation detected: expected ~${line_count} lines but got ${actualLines}. Provide the complete file content.`,
          expectedLines: line_count,
          actualLines,
        }));
        return;
      }
    }

    // Ensure parent directory exists
    const parentUri = vscode.Uri.joinPath(uri, '..');
    try {
      await vscode.workspace.fs.createDirectory(parentUri);
    } catch {
      // Directory may already exist — ignore
    }

    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    } catch (err) {
      context.pushError(JSON.stringify({
        error: `Cannot write file: ${filePath}`,
        resolvedPath: uri.fsPath,
        message: err instanceof Error ? err.message : String(err),
      }, null, 2));
      return;
    }

    const lineCount = content.split('\n').length;
    context.pushResult(JSON.stringify({
      path: filePath,
      resolvedPath: uri.fsPath,
      linesWritten: lineCount,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    }, null, 2));
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register all workspace tools with Bob's source registry.
 * These tools use vscode.workspace.fs directly, so they bypass Bob's
 * single-root sandbox and never trigger "outside workspace" confirmation prompts.
 *
 * Tools registered (6):
 *   list_workspace_folders  — discover all workspace roots
 *   read_workspace_file     — read any file (replaces read_file for non-primary folders)
 *   write_workspace_file    — write/create any file (replaces write_file for non-primary folders)
 *   list_workspace_files    — browse any directory (replaces list_files)
 *   search_workspace_files  — find files by glob (replaces glob)
 *   grep_workspace          — search file contents (replaces grep)
 */
export function registerWorkspaceTools(source: any) {
  source.registerTool(new ListWorkspaceFoldersTool());
  source.registerTool(new ReadWorkspaceFileTool());
  source.registerTool(new WriteWorkspaceFileTool());
  source.registerTool(new ListWorkspaceFilesTool());
  source.registerTool(new SearchWorkspaceFilesTool());
  source.registerTool(new GrepWorkspaceTool());
  registerWorkspacePromptInjection(source);
}

/**
 * Inject multi-root workspace context into the system prompt on the first turn
 * of every task.
 *
 * onTurnStart fires before the system message exists — Bob builds it during
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
          // System message not yet written — retry
          if (++attempts < MAX_POLLS) { setTimeout(tryInject, POLL_MS); }
          return;
        }

        systemMessage.content += injection;
      } catch {
        // Non-fatal — tools still work without the injection
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
    'Built-in tools (read_file, write_file, list_files, glob, grep) are SANDBOXED',
    'to the primary folder and will be blocked for all other folders.',
    '',
    'For any file in a secondary folder, use the workspace-specific tools.',
    'WORKFLOW: call list_workspace_folders → copy the folder "name" → pass it as the',
    '"workspace" parameter to read_workspace_file / write_workspace_file /',
    'list_workspace_files / search_workspace_files / grep_workspace.',
    'The "path" parameter on those tools is always RELATIVE to the workspace folder root.',
    '</multi_root_workspace>',
  ].join('\n');
}
