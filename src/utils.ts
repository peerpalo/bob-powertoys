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

import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as readline from 'readline';
import { access, stat } from 'fs/promises';

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
  const MAX_ATTEMPTS = 3;
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

// ─── Bob's ApplyDiffTool extraction ──────────────────────────────────────────

/**
 * Resolves Bob's ApplyDiffTool instance at call time by walking the task
 * manager's live task graph:
 *
 *   taskManager.mainPanelTask → chatManager
 *   chatManager.currentTask   → Task (has getTools())
 *   task.getTools()           → flat tool array
 *
 * Bob stores tools in a plain array on the Task object, not in the yZ map
 * registry. We look for the entry with id === "apply_diff".
 *
 * Returns null if the task manager is not ready or no task is active yet.
 */
export function getApplyDiffTool(): any {
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
  return tools.find((t: any) => t.id === 'apply_diff') ?? null;
}

// ─── ripgrep binary resolution (mirrors Bob's own logic) ─────────────────────

let _rgBinary: string | undefined;

/**
 * Field separator used with ripgrep's --field-match-separator flag.
 * ASCII Unit Separator (0x1F) - matches Bob's GrepTool exactly, and is
 * safe on macOS, Linux, and Windows since it never appears in file paths
 * or source code.
 */
export const RG_FIELD_SEP = '\x1f';

/**
 * Resolves the ripgrep binary shipped with VS Code itself.
 * Uses the same candidate list as Bob's own GrepTool. Result is cached.
 */
export async function resolveRipGrepBinary(): Promise<string | undefined> {
  if (_rgBinary) { return _rgBinary; }
  const exe = process.platform.startsWith('win') ? 'rg.exe' : 'rg';
  const plat = `${process.platform}-${process.arch}`;
  const appRoot = vscode.env.appRoot;
  const candidates = [
    path.join('node_modules/@vscode/ripgrep-universal/bin', plat, exe),
    path.join('node_modules.asar.unpacked/@vscode/ripgrep-universal/bin', plat, exe),
    path.join('node_modules/@vscode/ripgrep/bin', exe),
    path.join('node_modules/vscode-ripgrep/bin', exe),
    path.join('node_modules.asar.unpacked/vscode-ripgrep/bin', exe),
    path.join('node_modules.asar.unpacked/@vscode/ripgrep/bin', exe),
  ];
  for (const rel of candidates) {
    const full = path.join(appRoot, rel);
    const found = await access(full).then(() => true, () => false);
    if (found) { _rgBinary = full; return full; }
  }
  return undefined;
}

/**
 * Spawns ripgrep with the given args and returns all stdout as a string.
 * Kills the process after LINE_HARD_CAP lines to bound memory usage (mirrors Bob).
 * Rejects if there is no output (i.e. no matches).
 */
export function spawnRipGrep(binary: string, args: string[], lineHardCap = 300): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc: cp.ChildProcess;
    try {
      proc = cp.spawn(binary, args);
    } catch (err) {
      reject(err);
      return;
    }
    const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    let out = '';
    let lineCount = 0;
    rl.on('line', line => {
      if (lineCount < lineHardCap) {
        out += line + '\n';
        lineCount++;
      } else {
        rl.close();
        proc.kill();
      }
    });
    let stderr = '';
    proc.stderr!.on('data', d => { stderr += d.toString(); });
    rl.on('close', () => {
      out.trim() ? resolve(out) : reject(new Error(stderr || 'No matches'));
    });
    proc.on('error', err => reject(err));
  });
}

/**
 * stat() a list of paths in parallel and return a Map<path, mtimeMs>.
 * Missing files are silently omitted.
 */
export async function statMtimes(paths: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  await Promise.all(paths.map(p => stat(p).then(s => map.set(p, s.mtimeMs)).catch(() => {})));
  return map;
}

/**
 * Run ripgrep in --files mode (glob file search), collect paths sorted by mtime.
 * Mirrors Bob's GlobTool.exec + formatOutput:
 *   - hard cap at 2×maxResults lines before the process is killed
 *   - stat() all collected paths in parallel, sort newest-first, slice to maxResults
 * Returns the sorted absolute paths (may be fewer than maxResults if rg yields less).
 * Rejects if rg produces no output.
 */
export async function ripGrepFiles(
  binary: string,
  args: string[],
  maxResults: number
): Promise<string[]> {
  const hardCap = 2 * maxResults;
  const collected: string[] = await new Promise((resolve, reject) => {
    const proc = cp.spawn(binary, args);
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    const lines: string[] = [];
    rl.on('line', line => {
      if (!line.trim()) { return; }
      if (lines.length >= hardCap) { rl.close(); proc.kill(); return; }
      lines.push(line);
    });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    rl.on('close', () => {
      lines.length > 0 ? resolve(lines) : reject(new Error(stderr || 'No files found'));
    });
    proc.on('error', err => reject(err));
  });

  // stat in parallel, sort by mtime descending, slice to maxResults
  const withMtime = await Promise.all(
    collected.map(p => stat(p).then(s => ({ p, mtime: s.mtimeMs })).catch(() => ({ p, mtime: 0 })))
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime.slice(0, maxResults).map(x => x.p);
}

/**
 * Build --ignore-file args for ripgrep, mirroring Bob's buildIgnoreFileArgs.
 * Adds .gitignore (when respectGitIgnore=true) and .bobignore from the workspace root.
 * Each file that exists on disk is passed as "--ignore-file <path>".
 */
export async function buildIgnoreFileArgs(
  workspaceRoot: string,
  respectGitIgnore = true
): Promise<string[]> {
  const files: string[] = [];
  if (respectGitIgnore) { files.push('.gitignore'); }
  files.push('.bobignore');
  const args: string[] = [];
  for (const file of files) {
    const full = path.join(workspaceRoot, file);
    const found = await access(full).then(() => true, () => false);
    if (found) { args.push('--ignore-file', full); }
  }
  return args;
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
