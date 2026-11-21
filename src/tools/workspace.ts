/**
 * Workspace tools — multi-root workspace support for Bob.
 *
 * The heavy lifting is done by the multi-root sandbox patch (below): it makes
 * Bob's own outside-workspace check aware of every workspace folder, so ALL
 * built-in tools (read_file, write_file, list_files, glob, grep,
 * insert_content, search_and_replace, apply_diff, execute_command,
 * FindSymbol, FindReferencingSymbols, ...) work on secondary folders exactly
 * like on the primary one — no block, no approval prompt, and no reliance on
 * Bob's "Allow outside workspace" flags. No per-tool proxies are needed.
 *
 * What is left here:
 *   - list_workspace_folders — the one tool with no built-in equivalent
 *     (discover the root folders; environment_info only shows the primary)
 *   - the system-prompt injection that teaches the model the multi-root path
 *     rules
 *   - the webview patch that keeps click-to-open working for secondary folders
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { existsSync } from 'fs';
import { getTaskManager, findTaskChatManager, normaliseWorkspacePath, paramsToSchema, resolveOpenFilePath, isMultiRoot, logger } from '../utils.js';

/** Return all workspace folder roots as { name, uri, fsPath, index } objects. */
function getWorkspaceFolders() {
  return (vscode.workspace.workspaceFolders ?? []).map(f => ({
    name: f.name,
    uri: f.uri.toString(),
    fsPath: f.uri.fsPath,
    index: f.index,
  }));
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
      'This workspace is a MULTI-ROOT workspace: all tools work on files in every ' +
      'folder, but relative paths resolve against the PRIMARY folder only. ' +
      'Call this first on any task that might touch more than one project so you ' +
      'know the folder names and their absolute paths.'
    );
  }

  getCostEffectiveDescription(): string {
    return 'List all VS Code workspace folder roots - call first to discover folder names and paths';
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
      note: 'Relative paths resolve against the first (primary) folder. For secondary folders use absolute paths, "../<name>/..." or "<name>/..." (resolved inside that folder when it does not exist under the primary root).',
      folders,
    }, null, 2));
  }
}

// ─── Multi-root sandbox patch ─────────────────────────────────────────────────
//
// Root cause (Bob internals, extension.js): before every tool call, `sCr()`
// builds the tool's parameter schema via `tool.getParameters(env)`, collects
// the values of every parameter tagged `usage: "filePath"` and resolves each
// against `env.workspace` — which is always the PRIMARY workspace root. Any
// path under a secondary folder is flagged `isOutsideWorkspace: true`, which
// then either hard-blocks the call ("Allow outside workspace tool requests"
// off) or forces an approval prompt (unless the newer per-group
// `enableOutsideWorkspace` / global `outsideWorkspaceAllowed` flags are on).
//
// Neither state is correct for a multi-root workspace: a secondary folder IS
// part of the workspace the user opened. This patch makes Bob's own check
// workspace-aware:
//
//   1. `Task.recordToolCallArguments(toolCall)` — called synchronously at the
//      start of every tool call, BEFORE the sandbox computation — is wrapped
//      to stash the call's arguments keyed by task id.
//   2. The built-in file tools' `getParameters(env)` is wrapped so that, when
//      every `filePath`-tagged argument resolves inside one of the workspace
//      folders, the `usage: "filePath"` tag is dropped from the returned
//      descriptors for that call. `sCr()` then sees no file paths, computes
//      `isOutsideWorkspace: false`, and the call behaves exactly like a
//      primary-folder path: no block, no prompt, flags irrelevant.
//      Paths genuinely outside every folder keep their tags, so Bob's native
//      behavior (block / prompt / auto-approve per the user's flags) is
//      preserved for them.
//   3. The same tools' `call()` is wrapped to rewrite `folderName/...`-style
//      relative paths to absolute paths inside that folder (only when the
//      path does not exist under the primary root and does exist inside the
//      named folder), so the model can address secondary folders naturally.
//      For the symbol tools (FindSymbol / FindReferencingSymbols) the
//      forwarded context also gets `env.workspace` scoped to the resolved
//      folder, because those tools hardwire the workspace root for the
//      language-server query and their path parameters.
//
// All wraps are installed lazily from `source.onTurnStart` (the turn's task
// and its tool instances exist by then, and the wraps are in place before the
// turn's first tool call) and are generic: they read `this.id` at call time,
// so one prototype wrap covers every past and future instance of a tool
// class. Re-running on later turns catches tools exposed by modes that were
// not active earlier.
//
// Caveats (accepted, documented in DEVELOPMENT.md):
// - Mode `fileRegex` restrictions and the `isBobHomeWrite` flag are driven by
//   the same `filePath`-tagged values. We never strip for paths inside
//   `~/.bob`, so Bob's home-write protection is preserved; mode file-regex
//   restrictions are skipped for secondary-folder paths while a strip is
//   active (niche).
// - Depends on Bob internals (`recordToolCallArguments` on the Task
//   prototype, class-method `getParameters` on built-in tools, `env.id` being
//   the task id). If the shapes change, the wraps are simply never installed
//   and Bob falls back to its native single-root behavior.

/**
 * Built-in tools whose calls carry `usage: "filePath"` parameters and are
 * therefore subject to the outside-workspace check. Confirmed against
 * extension.js: read_file / write_file / list_files / glob / grep /
 * insert_content / search_and_replace / apply_diff tag `path`;
 * execute_command tags `cwd`.
 */
const BUILTIN_FILE_TOOLS = new Set([
  'read_file',
  'write_file',
  'list_files',
  'glob',
  'grep',
  'insert_content',
  'search_and_replace',
  'apply_diff',
  'execute_command',
]);

/**
 * Built-in symbol tools. Their path parameters are not `filePath`-tagged (no
 * sandbox issue), but they resolve paths against `env.workspace` and scope
 * the language-server query to it — so they need the `call()` rewrite plus
 * the `env.workspace` scoping.
 */
const SYMBOL_TOOLS = new Set(['FindSymbol', 'FindReferencingSymbols']);

/** Every built-in tool whose prototypes we wrap. */
const SANDBOX_TOOLS = new Set([...BUILTIN_FILE_TOOLS, ...SYMBOL_TOOLS]);

/** Built-in tool id → parameter names that carry paths (for the relative-path rewrite). */
const PATH_PARAMS_BY_TOOL: Record<string, readonly string[]> = {
  read_file:          ['path'],
  write_file:         ['path'],
  list_files:         ['path'],
  glob:               ['path'],
  grep:               ['path'],
  insert_content:     ['path'],
  search_and_replace: ['path'],
  apply_diff:         ['path'],
  execute_command:    ['cwd'],
  FindSymbol:               ['filter_path'],
  FindReferencingSymbols:   ['relative_path'],
};

// ─── State ────────────────────────────────────────────────────────────────────

export interface PendingToolCall {
  toolId: string;
  args: Record<string, any>;
}

/** taskId → arguments of the most recent tool call on that task. */
const pendingToolArgs = new Map<string, PendingToolCall>();

/** Prototypes of built-in tool classes we have already wrapped. */
// Prototypes are class-wide and live for the whole session, so a plain Set
// (which exposes .size for the log line) is fine here.
const patchedPrototypes = new Set<object>();

/** True once the one-time "applied" log line has been emitted. */
let patchLogged = false;

/** Stashed arguments of the most recent tool call on a task, if any. */
export function getPendingToolArgs(taskId: unknown): PendingToolCall | undefined {
  return typeof taskId === 'string' ? pendingToolArgs.get(taskId) : undefined;
}

function getFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

// ─── Pure decision logic (exported for tests) ─────────────────────────────────

/** True when `p` is `dir` itself or inside `dir` (case-insensitive on Windows). */
export function isInsideDir(p: string, dir: string): boolean {
  const norm = (x: string) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
  const a = norm(p);
  const b = norm(dir);
  const bPrefix = b.endsWith(path.sep) ? b : b + path.sep;
  return a === b || a.startsWith(bPrefix);
}

/** True when `p` is inside Bob's own home directory (`~/.bob`). */
function isInsideBobHome(p: string): boolean {
  return isInsideDir(p, path.join(os.homedir(), '.bob'));
}

/**
 * Resolve a path the way Bob's `vs()` does: expand a leading `~` to the user's
 * home directory, then resolve against the workspace root (absolute paths win).
 */
export function resolveLikeBob(workspaceRoot: string | undefined, value: string): string {
  const expanded = value.startsWith('~/') || value === '~'
    ? value.replace(/^~/, os.homedir())
    : value;
  return path.resolve(workspaceRoot ?? process.cwd(), expanded);
}

/**
 * Decide whether the `usage: "filePath"` tags should be stripped from a
 * parameter list for the call described by `args`.
 *
 * Returns true only when every provided `filePath` value resolves inside one
 * of the workspace folders (and none inside `~/.bob`, where Bob's own
 * home-write protection must stay intact). Any genuinely outside path makes
 * the call keep its tags so Bob's native flags/prompts apply unchanged.
 */
export function shouldStripFilePathUsage(
  params: readonly any[],
  args: Record<string, any> | undefined,
  env: any,
  folders: readonly { name: string; uri: { fsPath: string } }[],
): boolean {
  const filePathParams = params.filter(p => p?.usage === 'filePath');
  if (filePathParams.length === 0) { return false; }

  const workspaceRoot: string | undefined = env?.workspace;
  let anyValue = false;
  for (const p of filePathParams) {
    const raw = args?.[p.name];
    if (typeof raw !== 'string' || raw.trim() === '') { continue; }  // absent → Bob ignores it too
    anyValue = true;
    const abs = resolveLikeBob(workspaceRoot, raw);
    if (isInsideBobHome(abs)) { return false; }
    if (!folders.some(f => isInsideDir(abs, f.uri.fsPath))) { return false; }
  }
  return anyValue;
}

/**
 * Rewrite a relative path whose first segment is a secondary folder name
 * (e.g. `"backend/src/app.ts"`) to an absolute path inside that folder.
 *
 * Conservative by design: only fires when the path resolves nowhere under the
 * workspace root the tool would natively use AND the rewritten path exists on
 * disk. Everything else (absolute paths, `../`-escapes, `~`, plain
 * primary-relative paths) is returned unchanged.
 *
 * @param value        Raw parameter value.
 * @param workspaceRoot Root the tool natively resolves against (env.workspace).
 * @param folders      Secondary workspace folders eligible for name matching.
 */
export function rewriteSecondaryRelativePath(
  value: string,
  workspaceRoot: string | undefined,
  folders: readonly { name: string; uri: { fsPath: string } }[],
): string {
  if (typeof value !== 'string' || value === '' || path.isAbsolute(value)) { return value; }
  const norm = normaliseWorkspacePath(value);
  if (!norm || norm.startsWith('../')) { return value; }  // ../ escapes resolve natively

  const firstSeg = norm.split('/')[0];
  const folder = folders.find(f => f.name === firstSeg);
  if (!folder) { return value; }

  const native = path.join(workspaceRoot ?? process.cwd(), norm);
  if (existsSync(native)) { return value; }  // resolves fine natively — don't touch

  const rest = norm.slice(firstSeg.length).replace(/^[/\\]/, '');
  const candidate = rest ? path.join(folder.uri.fsPath, rest) : folder.uri.fsPath;
  return existsSync(candidate) ? candidate : value;
}

// ─── Patch installation ───────────────────────────────────────────────────────

/**
 * Patch `obj[name]` wherever it is defined (own property or anywhere on the
 * prototype chain) with `makeWrapper(original)`. Idempotent: wrappers are
 * tagged and skipped on re-install. Returns true when a (new) wrap was
 * installed or one was already present.
 */
function patchMethod(obj: any, name: string, makeWrapper: (original: any) => any): boolean {
  let owner: any = obj;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) {
    owner = Object.getPrototypeOf(owner);
  }
  if (!owner || typeof owner[name] !== 'function') { return false; }
  if ((owner[name] as any).__bobPtSandboxPatch) { return true; }

  const wrapper = makeWrapper(owner[name]);
  (wrapper as any).__bobPtSandboxPatch = true;
  owner[name] = wrapper;
  return true;
}

/**
 * Install the multi-root sandbox wraps.
 *
 * Registered as a `source.onTurnStart` callback: the turn's task and its tool
 * instances exist by then, and the wraps are in place before the turn's first
 * tool call. Prototypes are shared by class, so each class only needs to be
 * wrapped once; re-running on later turns catches tools exposed by modes that
 * were not active earlier.
 */
export function installMultiRootSandboxPatch(source: any): void {
  source.onTurnStart((taskId: string) => {
    // Fresh turn — arguments stashed during previous turns are stale.
    pendingToolArgs.clear();
    if (!isMultiRoot()) { return; }

    try {
      const tm = getTaskManager();
      const cm = tm ? findTaskChatManager(tm, taskId) : null;
      const task = cm?.currentTask;
      if (task) { patchForTask(task); }
    } catch (e) {
      logger.warn('multi-root sandbox patch: refresh failed', e);
    }
  });
}

/** Wrap `recordToolCallArguments` + the sandboxed built-in tools of one task. */
function patchForTask(task: any): void {
  // 1. Stash tool-call arguments before Bob's sandbox computation reads them.
  patchMethod(task, 'recordToolCallArguments', (original: any) =>
    function (this: any, toolCall: any) {
      try {
        if (toolCall?.name && toolCall?.arguments && typeof toolCall.arguments === 'object') {
          pendingToolArgs.set(this?.id, { toolId: toolCall.name, args: toolCall.arguments });
        }
      } catch { /* non-fatal: worst case Bob applies its native check */ }
      return original.call(this, toolCall);
    });

  // 2 + 3. Wrap the built-in file tools' getParameters (usage strip) and every
  //    sandboxed tool's call (relative-path rewrite; env scoping for symbol
  //    tools). Wrappers are generic — they resolve `this.id` at call time, so
  //    one prototype wrap covers every instance.
  for (const tool of task.getTools?.() ?? []) {
    if (tool && SANDBOX_TOOLS.has(tool.id)) { patchTool(tool); }
  }
}

function patchTool(tool: any): void {
  const proto = Object.getPrototypeOf(tool);
  if (proto) {
    if (patchedPrototypes.has(proto)) { return; }
    patchedPrototypes.add(proto);
  }

  patchMethod(tool, 'getParameters', (original: any) =>
    function (this: any, env?: any) {
      const params = original.call(this, env);
      if (!isMultiRoot() || !Array.isArray(params)) { return params; }
      const pending = getPendingToolArgs(env?.id);
      if (!pending || pending.toolId !== (this.id ?? this.getId?.())) { return params; }
      if (!shouldStripFilePathUsage(params, pending.args, env, getFolders())) { return params; }
      return params.map(p => p?.usage === 'filePath' ? { ...p, usage: undefined } : p);
    });

  const pathParams = PATH_PARAMS_BY_TOOL[tool.id];
  if (pathParams) {
    patchMethod(tool, 'call', (original: any) =>
      async function (this: any, context: any) {
        if (isMultiRoot() && context?.parameters && typeof context.env?.workspace === 'string') {
          const folders = getFolders();
          // Only native built-in calls resolve against the primary root — our
          // own delegation calls run with env.workspace patched to the target
          // folder and must not be rewritten. Compare case-insensitively on
          // Windows (isInsideDir both ways = path equality).
          const primaryFsPath = folders[0].uri.fsPath;
          const ws = context.env.workspace;
          const isPrimaryRoot = isInsideDir(ws, primaryFsPath) && isInsideDir(primaryFsPath, ws);
          if (folders.length > 1 && isPrimaryRoot) {
            const rewritten: Record<string, any> = { ...context.parameters };
            let changed = false;
            for (const name of pathParams) {
              const raw = rewritten[name];
              if (typeof raw !== 'string') { continue; }
              const fixed = rewriteSecondaryRelativePath(raw, ws, folders.slice(1));
              if (fixed !== raw) { rewritten[name] = fixed; changed = true; }
            }
            if (changed) {
              const forwarded = { ...context, parameters: rewritten };
              if (SYMBOL_TOOLS.has(this.id)) {
                // Bob's symbol tools hardwire env.workspace for the language-
                // server query and path resolution — scope it to the folder
                // containing the resolved path.
                const resolved = pathParams
                  .map(n => rewritten[n])
                  .find(v => typeof v === 'string' && path.isAbsolute(v));
                const folder = resolved
                  ? folders.slice(1).find(f => isInsideDir(resolved, f.uri.fsPath))
                  : undefined;
                if (folder) { forwarded.env = { ...context.env, workspace: folder.uri.fsPath }; }
              }
              return original.call(this, forwarded);
            }
          }
        }
        return original.call(this, context);
      });
  }

  if (!patchLogged && patchedPrototypes.size > 0) {
    logger.log(`multi-root sandbox patch: applied to ${patchedPrototypes.size} built-in tool class(es)`);
    patchLogged = true;
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register the multi-root workspace support with Bob's source registry:
 * the list_workspace_folders tool, the system-prompt injection that teaches
 * the model the multi-root path rules, and the multi-root sandbox patch that
 * makes Bob's built-in tools work on every workspace folder without approval.
 */
export function registerWorkspaceTools(source: any) {
  source.registerTool(new ListWorkspaceFoldersTool());
  registerWorkspacePromptInjection(source);
  installMultiRootSandboxPatch(source);
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
    if (!isEmpty || !isMultiRoot()) { return; }

    const injection = buildInjection(vscode.workspace.workspaceFolders ?? []);

    const MAX_POLLS = 50;   // ~500 ms total
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
  const folderLines = folders.map(f => `  - name="${f.name}"  fsPath="${f.uri.fsPath}"`);
  return [
    '',
    '<multi_root_workspace>',
    `This is a multi-root workspace with ${folders.length} root folders:`,
    ...folderLines,
    '',
    `The PRIMARY folder (against which relative paths resolve) is: ${folders[0].uri.fsPath}`,
    'All tools work on files in EVERY folder listed above - secondary folders need no',
    'special permission. Path rules for secondary folders:',
    '- prefer absolute paths (see the fsPath values above), or',
    '- use "../<folder-name>/..." relative to the primary root, or',
    '- use "<folder-name>/..." - when that path does not exist under the primary root,',
    '  it is resolved inside the named workspace folder (this also applies to the',
    '  filter_path/relative_path parameters of FindSymbol/FindReferencingSymbols).',
    '',
    'WORKFLOW: call list_workspace_folders to discover the folder names and paths.',
    '</multi_root_workspace>',
  ].join('\n');
}

/**
 * Fix click-to-open for secondary workspace folders.
 *
 * Bob's webview handler resolves relative paths in `openFile` messages
 * against the primary workspace root, so clicks on secondary-folder file
 * mentions open the wrong file. This patch wraps the `openFile` handler on
 * every webview (current and future, via cm.ui.setWebview and the
 * _chatManagers.push intercept) and rewrites `./<folderName>/...` paths to
 * their absolute location before Bob's own handler sees them.
 *
 * Called once from completeRegisterPowerToys(), after registerTaskManager()
 * has populated _cachedTaskManager.
 */
export function registerWebviewOpenFilePatch(): void {
  const tm = getTaskManager();
  if (!tm) { return; }

  const chatManagers: any[] = tm._chatManagers ?? [];

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

  /** Patch the openFile handler registration on a single webview instance. */
  function patchView(view: any): void {
    if (!view || view.__bobPtPatchedOpenFile) { return; }

    if (view.handlers?.openFile) {
      view.handlers.openFile = wrapHandler(view.handlers.openFile);
    }
    const originalOnMessage = view.onMessage.bind(view);
    view.onMessage = (type: string, handler: (msg: any) => any) => {
      return originalOnMessage(type, type === 'openFile' ? wrapHandler(handler) : handler);
    };

    view.__bobPtPatchedOpenFile = true;
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
