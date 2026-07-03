/**
 * Utility functions for Bob PowerToys tools
 */

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
      console.log('[Bob - PowerToys] taskManager obtained' + (bobExports?.taskManager ? ' via public API' : ' via internal hack') + (attempt > 1 ? ` (attempt ${attempt})` : ''));
      _cachedTaskManager = taskManager;
      return;
    }
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`[Bob - PowerToys] taskManager not available yet, retrying in ${DELAY_MS}ms (attempt ${attempt}/${MAX_ATTEMPTS})...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  throw new Error('[Bob - PowerToys] taskManager not available after all retries: Bob may have changed its internals');
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
