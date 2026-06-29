import * as vscode from 'vscode';
import { getTaskManager } from './tools/utils.js';

const LAST_SIDEBAR_TASK_ID_KEY = 'bob-powertoys.lastSidebarTaskId';
const TABS_TASK_IDS_KEY = 'bob-powertoys.tabsTaskIds';
const HAS_LAST_SIDEBAR_TASK_CTX = 'bob-powertoys.hasLastSidebarTask';

interface TabEntry { taskId: string; viewColumn: number; }
type TabsStore = Record<string, TabEntry[]>; // windowKey -> entries

// The last known sidebar task id - mirrors globalState and drives the context key.
let lastSidebarTaskId: string | undefined;

/**
 * Returns a stable partition key for the current window.
 *
 * vscode.window.tabGroups.all is scoped to the current OS window - each window
 * sees only its own tab groups. We fingerprint the window by combining:
 *   - the sorted list of viewColumn values present in this window's tab groups
 *   - vscode.env.sessionId (same across windows in a session, used as salt)
 *
 * This is stable for the lifetime of the session and unique per window even
 * when multiple windows share the same workspace.
 */
function windowKey(): string {
  const cols = vscode.window.tabGroups.all
    .map(g => g.viewColumn)
    .sort((a, b) => a - b)
    .join(',');
  return `${vscode.env.sessionId}:${cols}`;
}

// Tracks webviews we have already wrapped so we never double-patch.
const wrappedWebviews = new WeakSet();

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * Register the two task window commands.
 */
export function registerTaskCommands(context: vscode.ExtensionContext): void {
  // Open a brand-new task in a new OS window
  context.subscriptions.push(
    vscode.commands.registerCommand('bob-powertoys.newTaskInWindow', async () => {
      await vscode.commands.executeCommand('bob-code.task.pickWorkspaceInEditor');
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    })
  );

  // Open the current sidebar task in a new OS window
  context.subscriptions.push(
    vscode.commands.registerCommand('bob-powertoys.openTaskInWindow', async () => {
      const taskManager = getTaskManager();
      const chatManager = taskManager?.getTopLevelChatManager?.();
      const taskId = chatManager && chatManager.isEmpty?.() === false
        ? chatManager.getTaskId?.()
        : null;

      if (taskId) {
        await taskManager.openTask({});
        await taskManager.openTaskInNewTab(taskId);
        await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      } else {
        await vscode.commands.executeCommand('bob-code.task.pickWorkspaceInEditor');
        await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      }
    })
  );

  // Open the current sidebar task as an editor tab (no new window)
  context.subscriptions.push(
    vscode.commands.registerCommand('bob-powertoys.openTaskInEditor', async () => {
      const taskManager = getTaskManager();
      const chatManager = taskManager?.getTopLevelChatManager?.();
      const taskId = chatManager && chatManager.isEmpty?.() === false
        ? chatManager.getTaskId?.()
        : null;

      if (taskId) {
        await taskManager.openTask({});
        await taskManager.openTaskInNewTab(taskId);
      } else {
        await vscode.commands.executeCommand('bob-code.task.pickWorkspaceInEditor');
      }
    })
  );
}

// ── Last-task persistence ─────────────────────────────────────────────────────
// Saves the active sidebar task id by intercepting Bob's own webview messaging.
// When Bob sends setCurrentTasks to the webview we know exactly which task is
// active: no polling, no shutdown races.

/**
 * Patch the webview's sendMessage to intercept setCurrentTasks.
 * Safe to call multiple times - the WeakSet prevents double-patching.
 *
 * isPanel === false  (sidebar): save on every setCurrentTasks, even empty - clears state when user goes home.
 * isPanel === true   (tab):     only save when tasks.length > 0 - ignore the empty home-screen signal.
 */
function wrapWebviewSendMessage(context: vscode.ExtensionContext, chatManager: any, isPanel: boolean): boolean {
  const wv = chatManager?._webview ?? chatManager?.view;
  if (!wv || typeof wv.sendMessage !== 'function') { return false; }
  if (wrappedWebviews.has(wv)) { return true; }

  const originalSend = wv.sendMessage.bind(wv);
  wv.sendMessage = (msg: any) => {
    try {
      if (msg?.type === 'setCurrentTasks') {
        const hasTasks = (msg.tasks?.length ?? 0) > 0;
        console.log('[Bob - PowerToys] setCurrentTasks intercepted (isPanel=%s), tasks:', isPanel, msg.tasks?.length ?? 0);
        if (!isPanel || hasTasks) {
          saveTasks(context, chatManager, isPanel);
        }
      }
    } catch { /* never break Bob's messaging */ }
    return originalSend(msg);
  };

  // For tab panels, remove the task from TABS_TASK_IDS_KEY when the tab is closed.
  if (isPanel && typeof wv.onDispose === 'function') {
    wv.onDispose(() => {
      const taskId = chatManager?.getTaskId?.();
      if (taskId) { removeTabTask(context, taskId); }
    });
  }

  wrappedWebviews.add(wv);
  console.log('[Bob - PowerToys] webview sendMessage wrapped (isPanel=%s)', isPanel);
  return true;
}

/**
 * Hook up the sendMessage intercept on the current sidebar chatManager.
 * Also patches taskManager.openTask so every future tab chatManager is wrapped too.
 * Called once after registerTaskManager succeeds.
 */
export function registerTaskPersistence(context: vscode.ExtensionContext): void {
  const taskManager = getTaskManager();
  const chatManager = taskManager?.getTopLevelChatManager?.();
  
  if (!chatManager) {
    console.warn('[Bob - PowerToys] no chatManager: last task save disabled');
  } else {
    wrapWebviewSendMessage(context, chatManager, false);
  }

  // Tab chatManagers are created at runtime inside openTask. Patch it so we
  // can wrap each new tab webview the moment Bob hands it back.
  if (!taskManager || typeof taskManager.openTask !== 'function') {
    console.warn('[Bob - PowerToys] taskManager.openTask not found: tab task tracking disabled');
    return;
  }
  if (taskManager.__bobPowerToysPatched) { return; } // idempotent
  taskManager.__bobPowerToysPatched = true;

  const originalOpenTask = taskManager.openTask.bind(taskManager);
  taskManager.openTask = async (opts: any) => {
    const result = await originalOpenTask(opts);
    try {
      const wv = result?._webview ?? result?.view;
      if (wv?.isPanel === true) {
        wrapWebviewSendMessage(context, result, true);
      }
    } catch { /* never break Bob's openTask */ }
    return result;
  };

  console.log('[Bob - PowerToys] taskManager.openTask patched for tab tracking');
}

/**
 * Restore tasks from globalState.
 * - Sidebar task: reopened via openTask.
 * - Tab tasks: each reopened via openTaskInNewTab.
 * Called once at startup after registerTaskManager.
 */
export async function restoreTasks(context: vscode.ExtensionContext): Promise<void> {
  const taskManager = getTaskManager();

  // ── Sidebar ───────────────────────────────────────────────────────────────
  const lastTaskId = context.globalState.get<string>(LAST_SIDEBAR_TASK_ID_KEY);
  if (lastTaskId) {
    lastSidebarTaskId = lastTaskId;
    vscode.commands.executeCommand('setContext', HAS_LAST_SIDEBAR_TASK_CTX, true);
    console.log(`[Bob - PowerToys] Restoring last sidebar task: ${lastTaskId}`);
    try {
      await taskManager.openTask({ taskId: lastTaskId });
    } catch {
      console.warn(`[Bob - PowerToys] Could not restore sidebar task ${lastTaskId}: it may have been deleted`);
      lastSidebarTaskId = undefined;
      vscode.commands.executeCommand('setContext', HAS_LAST_SIDEBAR_TASK_CTX, false);
      await context.globalState.update(LAST_SIDEBAR_TASK_ID_KEY, undefined);
    }
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────
  // Each window runs restoreTasks independently in its own extension host.
  // We only restore the bucket matching THIS window's key - other windows
  // will restore their own buckets when their extension hosts start up.
  const currentKey = windowKey();
  const all = context.globalState.get<TabsStore>(TABS_TASK_IDS_KEY) ?? {};
  const entries = all[currentKey] ?? [];

  if (entries.length === 0 && !lastTaskId) {
    // This window has nothing to restore - it was reopened blank by VSCode's
    // window restore. Close it so it doesn't linger as an empty window.
    console.log('[Bob - PowerToys] Nothing to restore for this window');
    return;
  }

  const surviving: TabEntry[] = [];
  for (const entry of entries) {
    console.log(`[Bob - PowerToys] Restoring tab task: ${entry.taskId} col:${entry.viewColumn} (window: ${currentKey})`);
    try {
      const chatManager = await taskManager.openTaskInNewTab(entry.taskId);
      // Reveal the panel in its original column within this window.
      const panel: vscode.WebviewPanel | undefined = chatManager?._webview?.view ?? chatManager?.view?.view;
      panel?.reveal(entry.viewColumn, true);
      surviving.push(entry);
    } catch {
      console.warn(`[Bob - PowerToys] Could not restore tab task ${entry.taskId}: it may have been deleted`);
    }
  }

  if (surviving.length !== entries.length) {
    const updated: TabsStore = { ...all, [currentKey]: surviving };
    if (surviving.length === 0) { delete updated[currentKey]; }
    await context.globalState.update(TABS_TASK_IDS_KEY, Object.keys(updated).length > 0 ? updated : undefined);
  }
}

/**
 * Persist task id to globalState.
 * - isPanel === false (sidebar): saves the single sidebar task id, updates context key.
 * - isPanel === true  (tab):     adds the task id to the tabs set (idempotent).
 */
async function saveTasks(context: vscode.ExtensionContext, chatManager: any, isPanel: boolean): Promise<void> {
  if (!isPanel) {
    // ── Sidebar ─────────────────────────────────────────────────────────────
    const topLevelChatManager = chatManager?.taskManager?.getTopLevelChatManager();
    lastSidebarTaskId = topLevelChatManager && topLevelChatManager.isEmpty?.() === false
      ? topLevelChatManager.getTaskId?.()
      : undefined;

    console.log(`[Bob - PowerToys] Saving last sidebar task: ${lastSidebarTaskId}`);
    vscode.commands.executeCommand('setContext', HAS_LAST_SIDEBAR_TASK_CTX, !!lastSidebarTaskId);
    await context.globalState.update(LAST_SIDEBAR_TASK_ID_KEY, lastSidebarTaskId);
  } else {
    // ── Tab ──────────────────────────────────────────────────────────────────
    const taskId = chatManager?.getTaskId?.();
    if (!taskId) { return; }

    // Read the panel's current viewColumn from the underlying WebviewPanel.
    const panel: vscode.WebviewPanel | undefined = chatManager?._webview?.view ?? chatManager?.view?.view;
    const viewColumn: number = panel?.viewColumn ?? vscode.ViewColumn.One;

    const wsKey = windowKey();
    const all = context.globalState.get<TabsStore>(TABS_TASK_IDS_KEY) ?? {};
    const current = all[wsKey] ?? [];

    // Update entry if already tracked (viewColumn may have changed), otherwise add.
    const existing = current.findIndex(e => e.taskId === taskId);
    const entry: TabEntry = { taskId, viewColumn };
    const updated = existing >= 0
      ? current.map((e, i) => i === existing ? entry : e)
      : [...current, entry];

    console.log(`[Bob - PowerToys] Saving tab task: ${taskId} col:${viewColumn} (window: ${wsKey}, total: ${updated.length})`);
    await context.globalState.update(TABS_TASK_IDS_KEY, { ...all, [wsKey]: updated });
  }
}

/**
 * Remove a task id from TABS_TASK_IDS_KEY when its tab is closed.
 */
async function removeTabTask(context: vscode.ExtensionContext, taskId: string): Promise<void> {
  const wsKey = windowKey();
  const all = context.globalState.get<TabsStore>(TABS_TASK_IDS_KEY) ?? {};
  const current = all[wsKey] ?? [];
  const filtered = current.filter(e => e.taskId !== taskId);
  if (filtered.length === current.length) { return; }

  console.log(`[Bob - PowerToys] Removing tab task: ${taskId} (window: ${wsKey}, remaining: ${filtered.length})`);
  const updated: TabsStore = { ...all, [wsKey]: filtered };
  if (filtered.length === 0) { delete updated[wsKey]; }
  await context.globalState.update(TABS_TASK_IDS_KEY, Object.keys(updated).length > 0 ? updated : undefined);
}
