import * as vscode from 'vscode';
import { getBreakpointOwner } from './tools/breakpoints.js';
import { getTaskManager, findTaskChatManager } from './utils.js';

/**
 * Shared debug adapter state and tracking
 */

// Track the current stopped state for frame resolution
let currentStoppedState: { threadId: number; frameId?: number } | undefined;

// Debug output log for capturing recent console output
const debugOutputLog: Array<{ timestamp: Date; output: string }> = [];
const MAX_OUTPUT_LOG_SIZE = 100;

// Reference to Bob's exports for breakpoint notifications
let bobExportsRef: any = null;

// Queue for notifications that arrive while Bob is streaming
const pendingNotifications: string[] = [];

/**
 * Get the current stopped state (used by debug tools)
 */
export function getCurrentStoppedState(): { threadId: number; frameId?: number } | undefined {
  return currentStoppedState;
}

/**
 * Get recent debug output (used by breakpoint notifications)
 */
export function getRecentDebugOutput(lineCount: number = 20): string {
  return debugOutputLog.slice(-lineCount).map(e => e.output).join('');
}

/**
 * Safely inject a message into the specific Bob task that owns the breakpoint.
 */
async function safeNotify(chatManager: any, ownerTaskId: string, message: string): Promise<boolean> {
  try {
    const task = chatManager.currentTasks?.find((t: any) => t.getId() === ownerTaskId);
    if (!task) return false;

    const currentModeId = task.currentMode?.id;
    if (!currentModeId) return false;

    await chatManager.handleInputMessage(
      {
        type: 'userMessage',
        content: `${message}`,
        mode: currentModeId,
      },
      task  // targets the owning task, not the active one
    );

    return true;
  } catch (error) {
    console.error('[Bob PowerToys] safeNotify failed:', error);
    return false;
  }
}


/**
 * Notifies the Bob task that owns the breakpoint when it is hit.
 * Routes to the specific task via taskManager, supporting multiple concurrent tasks.
 */
async function notifyBobOfBreakpointHit(
  info: { file: string; line: number; stackTrace: any; variables: any; output: string }
): Promise<boolean> {
  try {
    // Check configuration setting
    const config = vscode.workspace.getConfiguration();
    const notificationMode = config.get<string>('breakpointNotifications', 'bobOnly');
    if (notificationMode === 'disabled') {
      return false;
    }

    const ownerTaskId = getBreakpointOwner(info.file, info.line);

    // bobOnly mode: only notify if Bob set this breakpoint
    if (notificationMode === 'bobOnly' && !ownerTaskId) {
      return false;
    }

    if (!bobExportsRef) {
      console.log('[Bob PowerToys] No Bob exports available');
      return false;
    }

    const taskManager = getTaskManager();
    if (!taskManager) {
      console.log('[Bob PowerToys] No taskManager access');
      return false;
    }

    if (!ownerTaskId) {
      console.log('[Bob PowerToys] No task owns this breakpoint - was it set outside Bob?');
      return false;
    }

    // Escalating lookup: active first, then backgrounded
    const chatManager = findTaskChatManager(taskManager, ownerTaskId);
    if (!chatManager) {
      console.log(`[Bob PowerToys] Task ${ownerTaskId} not reachable (active or backgrounded)`);
      return false;
    }

    // Confirm the owning task is actually present on this manager.
    // currentTasks covers the active case; currentTask covers the
    // backgrounded single-task case.
    const task =
      chatManager.currentTasks?.find((t: any) => t.getId() === ownerTaskId) ??
      (chatManager.currentTask?.getId?.() === ownerTaskId ? chatManager.currentTask : undefined);

    if (!task) {
      console.log('[Bob PowerToys] Owning task no longer present on its manager');
      return false;
    }

    const message = `Breakpoint hit at ${info.file}:${info.line}`;
    return await safeNotify(chatManager, ownerTaskId, message);
  } catch (error) {
    console.error('[Bob PowerToys] Error notifying Bob:', error);
    return false;
  }
}

/**
 * Flush any queued notifications once Bob is idle again.
 * Call this periodically or hook it to a task event.
 */
export async function flushPendingNotifications(): Promise<void> {
  if (pendingNotifications.length === 0) return;

  const taskManager = getTaskManager();
  if (!taskManager?.getChatManagerByTaskId) return;

  // Drain the queue, grouped by taskId
  const queued = pendingNotifications.splice(0, pendingNotifications.length);

  // Attempt to deliver each to the task it belongs to (best-effort)
  for (const message of queued) {
    // Extract taskId from the message prefix if present, otherwise skip
    const match = message.match(/^\[task:(.+?)\] /);
    if (!match) continue;
    const ownerTaskId = match[1];
    const chatManager = taskManager.getChatManagerByTaskId(ownerTaskId);
    if (!chatManager) continue;
    await safeNotify(chatManager, ownerTaskId, message.replace(/^\[task:.+?\] /, ''));
  }
}

/**
 * Register unified debug adapter tracker that handles both output capture and breakpoint notifications
 */
export function registerDebugAdapterTracker(bobExports: any): vscode.Disposable {
  bobExportsRef = bobExports;

  const trackerFactory: vscode.DebugAdapterTrackerFactory = {
    createDebugAdapterTracker(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterTracker> {
      return {
        onDidSendMessage: async (message: any) => {
          // Capture debug console output
          if (message.type === 'event' && message.event === 'output') {
            const output = message.body.output;
            if (output && typeof output === 'string') {
              debugOutputLog.push({ timestamp: new Date(), output });
              if (debugOutputLog.length > MAX_OUTPUT_LOG_SIZE) {
                debugOutputLog.shift();
              }
            }
          }

          // Track stopped state for frame resolution
          if (message.type === 'event' && message.event === 'stopped') {
            currentStoppedState = {
              threadId: message.body.threadId,
              frameId: undefined,
            };

            // Resolve frame ID asynchronously
            (async () => {
              try {
                const stack = await session.customRequest('stackTrace', {
                  threadId: message.body.threadId,
                  levels: 1,
                });
                if (currentStoppedState && stack.stackFrames?.length > 0) {
                  currentStoppedState.frameId = stack.stackFrames[0].id;
                }
              } catch (error) {
                console.error('[Bob PowerToys] Error resolving frame ID:', error);
              }
            })();

            // Handle breakpoint hits - notify Bob
            if (message.body.reason === 'breakpoint') {
              (async () => {
                const activeSession = vscode.debug.activeDebugSession;
                if (!activeSession) return;

                try {
                  const threadId = message.body.threadId;
                  
                  // Get stack trace
                  const stack = await activeSession.customRequest('stackTrace', { threadId, levels: 5 });
                  const frame = stack.stackFrames[0];
                  if (!frame) return;

                  // Get local variables
                  const scopes = await activeSession.customRequest('scopes', { frameId: frame.id });
                  const localScope = scopes.scopes.find((s: any) => s.name === 'Local' || s.name === 'Locals');
                  const vars = localScope
                    ? (await activeSession.customRequest('variables', { variablesReference: localScope.variablesReference })).variables
                    : [];

                  // Notify Bob with breakpoint information
                  await notifyBobOfBreakpointHit({
                    file: frame.source?.path ?? 'unknown',
                    line: frame.line,
                    stackTrace: stack.stackFrames,
                    variables: vars,
                    output: getRecentDebugOutput(20),
                  });
                } catch (error) {
                  console.error('[Bob PowerToys] Error processing breakpoint hit:', error);
                }
              })();
            }
          }

          // Clear stopped state when continuing
          if (message.type === 'event' && message.event === 'continued') {
            currentStoppedState = undefined;
          }
        },
      };
    },
  };

  return vscode.debug.registerDebugAdapterTrackerFactory('*', trackerFactory);
}