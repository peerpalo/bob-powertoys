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
import * as path from 'path';
import { getTaskManager, findTaskChatManager, resolveRipGrepBinary, spawnRipGrep, statMtimes, ripGrepFiles, buildIgnoreFileArgs, RG_FIELD_SEP, getApplyDiffTool } from '../utils.js';

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

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** True when the workspace has more than one root folder. */
function isMultiRoot(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}

/**
 * Notify Bob that a file was changed so it can show the "N files changed /
 * Undo all / Show all" UI.  Called BEFORE pushResult so the edit is registered
 * before the tool is considered done.
 *
 * Errors are swallowed on purpose: the file has already been written to disk,
 * so a failure here must never surface as a tool error.
 */
function notifyChange(
  trackChange: ((uri: string, edit: { before: string; after: string }) => void) | undefined,
  uri: vscode.Uri,
  before: string,
  after: string
): void {
  if (!trackChange) { return; }
  try {
    trackChange(uri.toString(), { before, after });
  } catch {
    // intentionally silent — the write already succeeded
  }
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
      'Then pass the folder\'s "name" as the "workspace" parameter to ' +
      'read_workspace_file / write_workspace_file / list_workspace_files / ' +
      'glob_workspace / grep_workspace.'
    );
  }

  getCostEffectiveDescription(): string {
    return 'List all VS Code workspace folder roots - call first, then use folder name as "workspace" param';
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
      note: 'Pass the folder "name" as the "workspace" parameter to read_workspace_file / write_workspace_file / list_workspace_files / glob_workspace / grep_workspace.',
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
      'List files and directories inside any folder in the VS Code workspace - including ' +
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

  parameters = GlobWorkspaceTool.PARAMS;
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
    const MAX_RESULTS = 100;

    if (!pattern?.trim()) {
      context.pushError('pattern is required');
      return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      context.pushError(JSON.stringify({ error: 'No workspace folders are open.' }));
      return;
    }

    let roots: Array<{ fsPath: string; label: string }>;
    if (workspace) {
      const resolved = resolveInFolder(workspace, subPath ?? '');
      if ('error' in resolved) {
        context.pushError(JSON.stringify({ error: resolved.error }));
        return;
      }
      roots = [{ fsPath: resolved.uri.fsPath, label: subPath ? `${workspace}/${subPath}` : workspace }];
    } else {
      roots = folders.map(f => ({ fsPath: f.uri.fsPath, label: f.name }));
    }

    const rgBinary = await resolveRipGrepBinary();
    if (!rgBinary) {
      context.pushError(JSON.stringify({ error: 'ripgrep binary not found under VS Code appRoot. Cannot search.' }));
      return;
    }

    const allPaths: string[] = [];
    for (const root of roots) {
      if (allPaths.length >= MAX_RESULTS) { break; }
      // Mirror Bob's GlobTool.call(): pass buildIgnoreFileArgs so .gitignore/.bobignore are respected
      const ignoreArgs = await buildIgnoreFileArgs(root.fsPath);
      const args = [
        '--files',
        '--hidden',
        '--glob=!.git/',
        '--no-messages',
        ...ignoreArgs,
        '--glob', pattern.replace(/\\/g, '/'),
        root.fsPath,
      ];
      try {
        const found = await ripGrepFiles(rgBinary, args, MAX_RESULTS - allPaths.length);
        allPaths.push(...found);
      } catch {
        // no matches in this root
      }
    }

    if (allPaths.length === 0) {
      context.pushResult('No files found');
      return;
    }

    const total = allPaths.length;
    const capped = total > MAX_RESULTS;
    const shown = capped ? allPaths.slice(0, MAX_RESULTS) : allPaths;
    // Paths are already relative to root; make them relative to the workspace root for display
    const lines: string[] = shown.map(p => {
      // Try to make relative to a workspace root for a clean display
      const folder = (vscode.workspace.workspaceFolders ?? []).find(f => p.startsWith(f.uri.fsPath));
      return folder ? path.relative(folder.uri.fsPath, p) : p;
    });
    if (capped) {
      lines.push('', `(Results truncated: showing ${MAX_RESULTS} of ${total} entries. Use a more specific path or pattern.)`);
    }
    context.pushResult(lines.join('\n'));
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

  parameters = GrepWorkspaceTool.PARAMS;
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
    const { pattern, workspace, path: subPath, include: includeGlob,
            ignore_case = false, invert_match = false, word_regexp = false,
            files_with_matches = false } = context.parameters;
    const MAX_MATCHES = 100;

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      context.pushError(JSON.stringify({ error: 'No workspace folders are open.' }));
      return;
    }

    // Determine search roots (fsPath strings)
    let roots: Array<{ fsPath: string; label: string }>;
    if (workspace) {
      const resolved = resolveInFolder(workspace, subPath ?? '');
      if ('error' in resolved) {
        context.pushError(JSON.stringify({ error: resolved.error }));
        return;
      }
      roots = [{ fsPath: resolved.uri.fsPath, label: subPath ? `${workspace}/${subPath}` : workspace }];
    } else {
      roots = folders.map(f => ({ fsPath: f.uri.fsPath, label: f.name }));
    }

    // Resolve ripgrep - fall back to pure-JS implementation if not found
    const rgBinary = await resolveRipGrepBinary();
    if (!rgBinary) {
      context.pushError(JSON.stringify({ error: 'ripgrep binary not found under VS Code appRoot. Cannot search.' }));
      return;
    }

    // Args that go before the per-root ignore files (same flags as Bob's GrepTool)
    const preArgs: string[] = ['--hidden', '--glob=!.git/', '--no-messages'];
    if (files_with_matches) {
      preArgs.unshift('-l');
    } else {
      preArgs.unshift('-nH', `--field-match-separator=${RG_FIELD_SEP}`);
    }

    // Args that go after the ignore files
    const postArgs: string[] = ['-e', pattern];
    if (ignore_case)   { postArgs.push('-i'); }
    if (invert_match)  { postArgs.push('-v'); }
    if (word_regexp)   { postArgs.push('-w'); }
    if (includeGlob)   { postArgs.push('--glob', includeGlob.replace(/\\/g, '/')); }

    // Run once per root and collect results
    interface LineMatch { line: number; text: string; }
    interface FileResult { folder: string; path: string; fullPath: string; matches: LineMatch[]; }
    const allResults: FileResult[] = [];
    let totalLines = 0;
    let capped = false;

    for (const root of roots) {
      // Build per-root ignore args so each workspace's .gitignore/.bobignore is respected
      const ignoreArgs = await buildIgnoreFileArgs(root.fsPath);
      const args = [...preArgs, ...ignoreArgs, ...postArgs, root.fsPath];
      let raw: string;
      try {
        raw = await spawnRipGrep(rgBinary, args);
      } catch (err) {
        // No matches in this root - mirror Bob: don't push error, just skip
        continue;
      }

      if (files_with_matches) {
        // Each line is a file path
        for (const line of raw.trim().split(/\r?\n/).filter(Boolean)) {
          allResults.push({
            folder: root.label,
            path: path.relative(root.fsPath, line),
            fullPath: line,
            matches: [],
          });
        }
        continue;
      }

      // Parse -nH --field-match-separator output: filePath<SEP>lineNum<SEP>text
      const fileMap = new Map<string, FileResult>();
      for (const line of raw.trim().split(/\r?\n/).filter(Boolean)) {
        const [filePath, lineNumStr, ...rest] = line.split(RG_FIELD_SEP);
        if (!filePath || !lineNumStr) { continue; }
        const lineNum = parseInt(lineNumStr, 10);
        if (isNaN(lineNum)) { continue; }
        const text = rest.join(RG_FIELD_SEP);

        if (!fileMap.has(filePath)) {
          fileMap.set(filePath, {
            folder: root.label,
            path: path.relative(root.fsPath, filePath),
            fullPath: filePath,
            matches: [],
          });
        }
        fileMap.get(filePath)!.matches.push({ line: lineNum, text });
        totalLines++;
        if (totalLines >= MAX_MATCHES) { capped = true; }
        if (capped) { break; }
      }
      allResults.push(...fileMap.values()); // always push, even if capped mid-file
      if (capped) { break; }
    }

    if (files_with_matches) {
      // Mirror Bob's formatFilesOutput: use relative paths, cap at MAX_MATCHES
      const relPaths = allResults.map(r => r.path);
      if (relPaths.length === 0) {
        context.pushResult('No files found');
        return;
      }
      const fileCapped = relPaths.length > MAX_MATCHES;
      const shownPaths = fileCapped ? relPaths.slice(0, MAX_MATCHES) : relPaths;
      const lines: string[] = [
        `Found ${relPaths.length} file${relPaths.length === 1 ? '' : 's'} with matches`,
        ...shownPaths,
      ];
      if (fileCapped) { lines.push('', '(Results truncated. Use a more specific path or pattern.)'); }
      context.pushResult(lines.join('\n'));
    } else {
      if (allResults.length === 0) {
        context.pushResult('No files found');
        return;
      }
      // Sort by mtime descending (newest first) - same as Bob's formatOutput
      const uniquePaths = [...new Set(allResults.map(r => r.fullPath))];
      const mtimes = await statMtimes(uniquePaths);
      allResults.sort((a, b) => (mtimes.get(b.fullPath) ?? 0) - (mtimes.get(a.fullPath) ?? 0));

      const lines: string[] = [`Found ${totalLines} match${totalLines === 1 ? '' : 'es'}${capped ? ` (showing first ${MAX_MATCHES})` : ''}`];
      for (const file of allResults) {
        lines.push('');
        lines.push(`${file.path}:`);
        for (const m of file.matches) {
          lines.push(`  Line ${m.line}: ${m.text.length > 2000 ? m.text.substring(0, 2000) + '...' : m.text}`);
        }
      }
      if (capped) { lines.push(''); lines.push('(Results truncated. Use a more specific path or pattern.)'); }
      context.pushResult(lines.join('\n'));
    }
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
    trackChange?: (uri: string, edit: { before: string; after: string }) => void;
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

    // Read previous content for change tracking (best-effort; empty string for new files)
    let before = '';
    try {
      const prevBytes = await vscode.workspace.fs.readFile(uri);
      before = Buffer.from(prevBytes).toString('utf8');
    } catch {
      // New file - before stays ''
    }

    // Ensure parent directory exists
    const parentUri = vscode.Uri.joinPath(uri, '..');
    try {
      await vscode.workspace.fs.createDirectory(parentUri);
    } catch {
      // Directory may already exist - ignore
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

    notifyChange(context.trackChange, uri, before, content);

    const lineCount = content.split('\n').length;
    context.pushResult(JSON.stringify({
      path: filePath,
      resolvedPath: uri.fsPath,
      linesWritten: lineCount,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    }, null, 2));
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

  parameters = InsertWorkspaceContentTool.PARAMS;
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
    trackChange?: (uri: string, edit: { before: string; after: string }) => void;
  }): Promise<void> {
    const { workspace, path: filePath, line, content } = context.parameters;

    const resolved = resolveInFolder(workspace, filePath);
    if ('error' in resolved) {
      context.pushError(JSON.stringify({ error: resolved.error }));
      return;
    }
    const { uri } = resolved;

    let existing: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      existing = Buffer.from(bytes).toString('utf8');
    } catch (err) {
      context.pushError(`Error reading file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const lineNum = Number(line);
    if (isNaN(lineNum) || lineNum < 0) {
      context.pushError(`Invalid line number ${line}. Must be 0 or greater.`);
      return;
    }

    // Detect line ending
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const rows = existing.split(/\r?\n/);

    if (lineNum > rows.length) {
      context.pushError(`Invalid line number ${lineNum}. File only has ${rows.length} lines.`);
      return;
    }

    // Normalise inserted content to match file's line ending
    const normalised = content.replace(/\r?\n/g, eol);

    let after: string;
    if (lineNum === 0) {
      // Append: ensure file ends with a newline before appending
      after = existing + (existing.endsWith('\n') ? '' : eol) + normalised;
    } else {
      // Insert before the given line (1-based → 0-based index)
      rows.splice(lineNum - 1, 0, normalised);
      after = rows.join(eol);
    }

    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(after, 'utf8'));
    } catch (err) {
      context.pushError(`Error inserting content into file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    notifyChange(context.trackChange, uri, existing, after);

    context.pushResult(
      `Inserted content ${lineNum === 0 ? 'at end of' : `before line ${lineNum} of`} ` +
      `${workspace}/${filePath} (file now has ${after.split(/\r?\n/).length} lines)`
    );
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

  parameters = SearchAndReplaceWorkspaceTool.PARAMS;
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
    trackChange?: (uri: string, edit: { before: string; after: string }) => void;
  }): Promise<void> {
    const { workspace, path: filePath, search, replace,
            start_line, end_line, use_regex, ignore_case } = context.parameters;

    const toBool = (v: string | boolean | undefined): boolean =>
      typeof v === 'boolean' ? v :
      v === '1' || String(v ?? '').toLowerCase() === 'true' || String(v ?? '').toLowerCase() === 'yes';

    const useRegex  = toBool(use_regex);
    const ignoreCase = toBool(ignore_case);

    const resolved = resolveInFolder(workspace, filePath);
    if ('error' in resolved) {
      context.pushError(JSON.stringify({ error: resolved.error }));
      return;
    }
    const { uri } = resolved;

    let existing: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      existing = Buffer.from(bytes).toString('utf8');
    } catch (err) {
      context.pushError(`Error reading file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const rows = existing.split(eol);
    const lineCount = rows.length;

    // Validate line range
    if (start_line !== undefined && (start_line < 1 || start_line > lineCount)) {
      context.pushError(`Invalid start_line: ${start_line}. Must be between 1 and ${lineCount}.`);
      return;
    }
    if (end_line !== undefined && (end_line < 1 || end_line > lineCount)) {
      context.pushError(`Invalid end_line: ${end_line}. Must be between 1 and ${lineCount}.`);
      return;
    }
    if (start_line !== undefined && end_line !== undefined && start_line > end_line) {
      context.pushError(`Invalid line range: start_line (${start_line}) must be less than or equal to end_line (${end_line})`);
      return;
    }

    // Build regex - use 's' (dotAll) flag so '.' spans newlines, enabling multi-line search
    let pattern: RegExp;
    try {
      if (useRegex) {
        pattern = new RegExp(search, ignoreCase ? 'gis' : 'gs');
      } else {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        pattern = new RegExp(escaped, ignoreCase ? 'gis' : 'gs');
      }
    } catch (err) {
      context.pushError(`Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let after: string;
    let replacementCount = 0;

    const hasLineRange = start_line !== undefined || end_line !== undefined;

    if (!hasLineRange) {
      // No line range: operate on the full file string so multi-line search/replace works correctly
      const matches = existing.match(pattern);
      if (!matches) {
        context.pushError(`No matches found for search pattern`);
        return;
      }
      replacementCount = matches.length;
      after = existing.replace(pattern, replace);
    } else {
      // Line range: operate row-by-row on the restricted slice, same as Bob's computeEdit
      const startIdx = start_line !== undefined ? start_line - 1 : 0;
      const endIdx   = end_line   !== undefined ? end_line       : lineCount;
      const newRows: string[] = rows.map((row, i) => {
        if (i >= startIdx && i < endIdx) {
          const m = row.match(pattern);
          if (m) {
            replacementCount += m.length;
            return row.replace(pattern, replace);
          }
        }
        return row;
      });
      if (replacementCount === 0) {
        const rangeNote = ` in lines ${start_line || 1}-${end_line || lineCount}`;
        context.pushError(`No matches found for search pattern${rangeNote}`);
        return;
      }
      after = newRows.join(eol);
    }

    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(after, 'utf8'));
    } catch (err) {
      context.pushError(`Error writing file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    notifyChange(context.trackChange, uri, existing, after);

    const rangeNote = hasLineRange
      ? ` in lines ${start_line || 1}-${end_line || lineCount}` : '';
    context.pushResult(`Successfully replaced ${replacementCount} occurrence(s)${rangeNote} in ${workspace}/${filePath}`);
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

  parameters = ApplyDiffWorkspaceTool.PARAMS;
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
    trackChange?: (uri: string, edit: { before: string; after: string }) => void;
  }): Promise<void> {
    const { workspace, path: filePath, diff } = context.parameters;

    // Resolve workspace root
    const resolved = resolveInFolder(workspace, '');
    if ('error' in resolved) {
      context.pushError(resolved.error);
      return;
    }
    const folderRoot = resolved.uri.fsPath;
    const absolutePath = path.resolve(folderRoot, filePath);

    // Make sure the file exists
    const fileUri = vscode.Uri.file(absolutePath);
    let originalContent: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      originalContent = Buffer.from(bytes).toString('utf8');
    } catch {
      context.pushError(`File does not exist at path: ${filePath}`);
      return;
    }

    // Resolve Bob's ApplyDiffTool from the active task at call time.
    const applyDiffTool = getApplyDiffTool();
    if (!applyDiffTool) {
      context.pushError(
        'apply_diff_workspace: Bob\'s diff engine is not available. ' +
        'Make sure a Bob task is active, then retry.'
      );
      return;
    }

    // Delegate to Bob's applyDiff() - same fuzzy engine, same format
    let result: { success: boolean; content?: string; failParts?: any[] };
    try {
      result = await applyDiffTool.applyDiff(originalContent, diff);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      context.pushError(`Error applying diff: ${msg}`);
      return;
    }

    if (!result.success) {
      // Mirror Bob's error message format
      const failDetails = result.failParts?.find((p: any) => !p.applied && p.error);
      context.pushError(
        failDetails?.error ??
        `Unable to apply diff to file: ${filePath}\nAll SEARCH blocks failed to match.`
      );
      return;
    }

    // Write the patched content back
    const patchedContent = result.content!;
    try {
      const out = Buffer.from(patchedContent, 'utf8');
      await vscode.workspace.fs.writeFile(fileUri, out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      context.pushError(`Diff computed but failed to write file: ${msg}`);
      return;
    }

    notifyChange(context.trackChange, fileUri, originalContent, patchedContent);

    const failCount = result.failParts?.filter((p: any) => !p.applied).length ?? 0;
    if (failCount > 0) {
      context.pushResult(
        `Unable to apply all diff parts to file: ${filePath}, ` +
        `use read_workspace_file to check the newest file version and re-apply diffs`
      );
    } else {
      context.pushResult(`Applied diff to ${workspace}/${filePath}`);
    }
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register all workspace tools with Bob's source registry.
 * These tools use vscode.workspace.fs directly, so they bypass Bob's
 * single-root sandbox and never trigger "outside workspace" confirmation prompts.
 *
 * Tools registered (9):
 *   list_workspace_folders        - discover all workspace roots
 *   read_workspace_file           - read any file (replaces read_file)
 *   write_workspace_file          - write/create any file (replaces write_file)
 *   list_workspace_files          - browse any directory (replaces list_files)
 *   glob_workspace                - find files by glob (replaces glob)
 *   grep_workspace                - search file contents (replaces grep)
 *   insert_workspace_content      - insert lines without overwriting (replaces insert_content)
 *   search_and_replace_workspace  - find/replace in file (replaces search_and_replace)
 *   apply_diff_workspace          - apply diff blocks (replaces apply_diff)
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
    'Built-in tools (read_file, write_file, list_files, glob, grep, insert_content,',
    'search_and_replace) are SANDBOXED to the primary folder and will be blocked for',
    'all other folders.',
    '',
    'For any file in a secondary folder, use the workspace-specific tools:',
    '  read_workspace_file           - replaces read_file',
    '  write_workspace_file          - replaces write_file',
    '  list_workspace_files          - replaces list_files',
    '  glob_workspace                - replaces glob',
    '  grep_workspace                - replaces grep',
    '  insert_workspace_content      - replaces insert_content',
    '  search_and_replace_workspace  - replaces search_and_replace',
    '  apply_diff_workspace          - replaces apply_diff',
    '',
    'WORKFLOW: call list_workspace_folders → copy the folder "name" → pass it as the',
    '"workspace" parameter to the tool above.',
    'The "path" parameter on those tools is always RELATIVE to the workspace folder root.',
    '</multi_root_workspace>',
  ].join('\n');
}
