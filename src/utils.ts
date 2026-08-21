/**
 * Utility functions for PowerToys for Bob tools
 */

export const EXTENSION_ID = 'bob-powertoys';
export const EXTENSION_DISPLAY_NAME = 'PowerToys for Bob';
export const LOG_PREFIX = `[${EXTENSION_DISPLAY_NAME}]`;

export const logger = {
  log:   (msg: string, ...args: unknown[]) => console.log(`${LOG_PREFIX} ${msg}`, ...args),
  warn:  (msg: string, ...args: unknown[]) => console.warn(`${LOG_PREFIX} ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`${LOG_PREFIX} ${msg}`, ...args),
};

import * as path from 'path';
import { existsSync } from 'fs';
import { createPatch } from 'diff';

export { createPatch };

// Cached taskManager instance - populated once by initTaskManager(), reused everywhere.
let _cachedTaskManager: any = null;

/**
 * Extracts Bob's internal taskManager by temporarily patching Array.prototype.find.
 *
 * bobExports.setChatContent → t.getTopLevelChatManager() → this.mainPanelTask
 * → this._chatManagers.find(e => e.view?.isPanel === false)
 *
 * _chatManagers is a plain Array, so Array.prototype.find fires with
 * `this` = the _chatManagers array. Each element is a J8e instance whose
 * .taskManager property is the _4 instance (N0) we want.
 *
 * The patch lives for a single synchronous setChatContent call then is removed.
 * Returns null if no chat managers exist yet.
 */
export function extractTaskManager(bobExports: any): any {
  let taskManager: any = null;
  const originalFind = Array.prototype.find;

  (Array.prototype as any).find = function(predicate: any, ...args: any[]) {
    // Heuristic: _chatManagers elements have a .taskManager property
    if (taskManager === null && this.length > 0 && this[0]?.taskManager !== undefined) {
      taskManager = this[0].taskManager;
    }
    return originalFind.call(this, predicate, ...args);
  };

  try {
    bobExports.setChatContent('', false);
  } finally {
    Array.prototype.find = originalFind;
  }

  return taskManager;
}

/**
 * Resolves and caches the taskManager from Bob's exports.
 * Tries the public API first, then falls back to the internal hack.
 * Retries up to 3 times with a 1s delay if the hack returns null
 * (can happen if setChatContent is called before the chat panel is ready).
 * Throws if all attempts fail.
 */
export async function registerTaskManager(bobExports: any): Promise<void> {
  const MAX_ATTEMPTS = 10;
  const DELAY_MS = 1000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const taskManager = bobExports?.taskManager ?? extractTaskManager(bobExports);
    if (taskManager != null) {
      logger.log('taskManager obtained' + (bobExports?.taskManager ? ' via public API' : ' via internal hack') + (attempt > 1 ? ` (attempt ${attempt})` : ''));
      _cachedTaskManager = taskManager;
      return;
    }
    if (attempt < MAX_ATTEMPTS) {
      logger.warn(`taskManager not available yet, retrying in ${DELAY_MS}ms (attempt ${attempt}/${MAX_ATTEMPTS})...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  throw new Error(`${LOG_PREFIX} taskManager not available after all retries: Bob may have changed its internals`); // keep prefix in Error message
}

/**
 * Returns the cached taskManager set by registerTaskManager().
 */
export function getTaskManager(): any {
  return _cachedTaskManager;
}

/**
 * Resolve the chat manager for a task, checking both active and
 * backgrounded (open-but-not-focused) states.
 */
export function findTaskChatManager(taskManager: any, taskId: string): any | null {
  // State 1: active task (present in some manager's currentTasks)
  let chatManager = taskManager.getChatManagerByTaskId?.(taskId);
  if (chatManager) return chatManager;

  // State 2: open but backgrounded (manager exists, matched by root task id)
  chatManager = taskManager.getOpenChatManagerByRootTaskId?.(taskId);
  if (chatManager) return chatManager;

  return null;
}

// ─── Bob built-in tool lookup ─────────────────────────────────────────────────

/**
 * Resolves any registered Bob built-in tool instance at call time by walking
 * the task manager's live task graph:
 *
 *   taskManager.mainPanelTask → chatManager
 *   chatManager.currentTask   → Task (has getTools())
 *   task.getTools()           → flat tool array
 *
 * Bob stores tools in a plain array on the Task object, not in the yZ map
 * registry. We search by the tool's `id` field.
 *
 * Returns null if the task manager is not ready, no task is active, or the
 * requested tool is not present in the current mode.
 */
export function getBobTool(toolId: string): any {
  const taskManager = _cachedTaskManager;
  if (!taskManager) { return null; }

  // Prefer the main panel chat manager; fall back to the first available one.
  const chatManager: any =
    taskManager.mainPanelTask ??
    taskManager._chatManagers?.[0];
  if (!chatManager) { return null; }

  const task = chatManager.currentTask;
  if (!task) { return null; }

  const tools: any[] = task.getTools?.() ?? [];
  return tools.find((t: any) => t.id === toolId) ?? null;
}

/**
 * Normalise a user-supplied relative path for use with vscode.Uri.joinPath.
 * - Converts backslashes to forward slashes
 * - Strips a leading "./" (current-directory prefix)
 * - Strips a bare leading "/" (accidental absolute prefix)
 * - Collapses a lone "." to "" so the caller falls back to the folder root
 *
 * Deliberately does NOT strip a leading "." that is followed by a non-slash
 * character, so dotfolders like ".bob", ".idea", ".git" are preserved intact.
 */
export function normaliseWorkspacePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')   // backslash → forward slash
    .replace(/^\.\//, '')  // strip leading "./"
    .replace(/^\//, '')    // strip leading "/"
    .replace(/^\.$/, '');  // collapse lone "." → "" (folder root)
}

/**
 * Resolve a frame ID for debug operations.
 * If the provided frameId is undefined, null, or <= 0, resolves to the top frame.
 *
 * @param frameId The frame ID from parameters (may be undefined, null, or invalid)
 * @param resolveTopFrame Async function to resolve the top frame ID
 * @returns The resolved frame ID
 */
export async function resolveFrameId(
  frameId: number | undefined | null,
  resolveTopFrame: () => Promise<number | undefined>
): Promise<number | undefined> {
  // If frameId is provided and valid (> 0), use it
  if (frameId !== undefined && frameId !== null && frameId > 0) {
    return frameId;
  }
  
  // Otherwise, resolve to top frame
  return await resolveTopFrame();
}

/**
 * Convert a PARAMS array into the object-form OpenAI JSON Schema that Bob's
 * `toolToOpenAi` passes through verbatim, preserving `usage`, `detail`, and
 * `renderHint`.
 *
 * Background: `toolToOpenAi` detects `Array.isArray(o.parameters)` and, when
 * true, only copies `{ type, description }` per entry — stripping everything
 * else. When `o.parameters` is already a plain object it is returned as-is,
 * so extra fields survive into the registered schema.
 *
 * Bob's registration then sets `getParameters: () => r` on the registered tool,
 * so the tool's own `getParameters()` is never called by Bob's pipeline — only
 * by our own code. All four fields must therefore live in the object returned here.
 *
 * Each entry in `params` should have:
 * @param name        - parameter key, matches context.parameters key
 * @param type        - 'string' | 'number' | 'boolean' | 'array'
 * @param required    - if true, included in the schema's required[] array
 * @param description - full sentence - sent to the LLM via toolToOpenAi() in extension.js (BobToolRegistry)
 * @param detail      - short label  - shown in the approval dialog;
 *                      read by getParameterRenderHints() in extension.js module 25772 (tool parameter utilities);
 *                      paramsToSchema mirrors description/detail as fallback (each fills in for the other if missing)
 * @param usage       - example value for autocomplete hints;
 *                      sentinel 'command' triggers the Approve/Reject dialog;
 *                      read by getParameterUses() in extension.js module 25772 (tool parameter utilities)
 * @param renderHint  - optional, controls approval dialog field rendering;
 *                      read by getParameterRenderHints() in extension.js module 25772 (tool parameter utilities):
 *                        'code'   - single-line code block
 *                        'diff'   - diff viewer
 *                        'json'   - JSON viewer
 *                        'text'   - plain text
 *                        'hidden' - field not shown in dialog
 *                        omit     - default name:value style
 *                      if NO param has renderHint - entire tool falls back to
 *                      a single raw JSON blob in the dialog
 */
export function paramsToSchema(params: ReadonlyArray<{
  name:        string;
  type:        string;
  description?: string;
  detail?:      string;
  required?:    boolean;
  usage?:       string;
  renderHint?:  string;
  [key: string]: unknown;
}>) {
  const properties: Record<string, any> = {};
  for (const p of params) {
    // `description` - read by toolToOpenAi() in extension.js (BobToolRegistry), sent to the LLM.
    // `detail`      - read by getParameterRenderHints() in extension.js module 25772 as the field sub-label.
    // Both must be present in the schema object so each pipeline finds what it expects.
    const entry: Record<string, any> = {
      type: p.type,
      description: p.description ?? p.detail ?? '',
      detail:      p.detail      ?? p.description ?? '',
    };
    if (p.usage)      { entry.usage      = p.usage; }
    if (p.renderHint) { entry.renderHint = p.renderHint; }
    properties[p.name] = entry;
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: params.filter(p => p.required).map(p => p.name),
  };
}

// ─── Workspace path helpers (used by workspace tools + webview patch) ─────────

/**
 * Absolutise relative file paths in a glob or grep tool-result string.
 *
 * Bob's formatOutput / formatFilesOutput always writes one path per line
 * (glob) or `<path>:` header lines (grep), using path.relative() — so every
 * line is either a well-formed relative path or already absolute.
 *
 * @param content       Raw text returned by Bob's tool.
 * @param tool          'glob' for glob/list_files output; 'grep' for grep output.
 * @param workspaceRoot Absolute path of the folder the tool ran against.
 */
export function absolutiseToolContent(
  content: string,
  tool: 'glob' | 'grep',
  workspaceRoot: string,
): string {
  if (!workspaceRoot || !content) { return content; }

  if (tool === 'glob') {
    // Each line is a path.relative() result — leave already-absolute lines alone.
    return content.split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed || path.isAbsolute(trimmed)) { return line; }
      // If the line has no path separator but contains a space it is ambiguous:
      // it could be a root-level filename with spaces ("My File.ts") or prose
      // ("No files found").  Resolve the ambiguity with an existence check —
      // only absolutise if the joined path actually exists on disk.
      const hasSeparator = trimmed.includes('/') || trimmed.includes('\\');
      if (!hasSeparator && trimmed.includes(' ')) {
        const candidate = path.join(workspaceRoot, trimmed);
        return existsSync(candidate) ? candidate : line;
      }
      return path.join(workspaceRoot, trimmed);
    }).join('\n');
  }

  // grep: file-header lines are `<relPath>:` — strip the colon, absolutise, restore it.
  return content.split('\n').map(line => {
    if (!line.endsWith(':')) { return line; }
    const filePath = line.slice(0, -1);
    if (!filePath || path.isAbsolute(filePath)) { return line; }
    // Same space-at-root ambiguity as the glob branch: a line like "My File.ts:"
    // could be a valid file header or accidental prose ending with a colon.
    // Only absolutise if the file actually exists on disk.
    const hasSeparator = filePath.includes('/') || filePath.includes('\\');
    if (!hasSeparator && filePath.includes(' ')) {
      const candidate = path.join(workspaceRoot, filePath);
      return existsSync(candidate) ? candidate + ':' : line;
    }
    return path.join(workspaceRoot, filePath) + ':';
  }).join('\n');
}

/**
 * Resolve a relative file path that starts with a known workspace folder name
 * (e.g. `"./process-discovery/src/api/foo.js"`) to its absolute path.
 *
 * Bob's `kH()` resolver uses the primary workspace root for all relative paths,
 * so clicks on secondary-folder file mentions open the wrong file.  This
 * function is called before Bob's handler sees the path.
 *
 * The webview's `ct()` helper prepends `"./"` to all relative paths — we strip
 * that prefix before matching against folder names.
 *
 * @param filePath  Path as received in the `openFile` webview message.
 * @param folders   VS Code workspace folder list (pass `vscode.workspace.workspaceFolders`).
 * @returns The absolute path if a folder-name match is found, otherwise `filePath` unchanged.
 */
export function resolveOpenFilePath(
  filePath: string,
  folders: ReadonlyArray<{ name: string; uri: { fsPath: string } }>,
): string {
  if (!filePath || path.isAbsolute(filePath)) { return filePath; }
  // Strip the "./" prefix that the webview's ct() always prepends.
  const stripped = filePath.replace(/^\.\//, '');
  for (const folder of folders) {
    const prefix = folder.name;
    if (stripped === prefix ||
        stripped.startsWith(prefix + '/') ||
        stripped.startsWith(prefix + '\\')) {
      const rel = stripped.slice(prefix.length).replace(/^[/\\]/, '');
      return rel ? path.join(folder.uri.fsPath, rel) : folder.uri.fsPath;
    }
  }
  return filePath;
}
