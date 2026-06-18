import * as vscode from 'vscode';
import { isBobSetBreakpoint } from './tools/breakpoints.js';

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
 * Safely inject a message into the chat, avoiding collisions with Bob's
 * interactive ask/response flow.
 */
async function safeNotify(task: any, message: string): Promise<boolean> {
  try {
    const lastMsg = task.clineMessages?.at(-1);

    // Check if Bob is idle (finished) or actively running
    const isIdle = !task.isStreaming && !task.isWaitingForFirstChunk;

    // If Bob is mid-stream, queue and bail
    if (lastMsg?.partial === true || !isIdle) {
      pendingNotifications.push(message);
      return false;
    }

    // Bob finished its turn — submit a new message to make it respond
    // This triggers a fresh turn, like the user typed it
    await task.submitUserMessage(
      `${message}`,
      []
    );

    return true;
  } catch (error) {
    console.error('[Bob - PowerToys] Notify failed:', error);
    return false;
  }
}

/**
 * Notifies the active Bob chat when a breakpoint is hit.
 * This automatically injects breakpoint information into Bob's conversation.
 */
async function notifyBobOfBreakpointHit(
  info: { file: string; line: number; stackTrace: any; variables: any; output: string }
): Promise<boolean> {
  try {
    // Check configuration setting
    const config = vscode.workspace.getConfiguration();
    const notificationMode = config.get<string>('breakpointNotifications', 'bobOnly');

    // If disabled, skip notification
    if (notificationMode === 'disabled') {
      return false;
    }

    // If bobOnly mode, check if this breakpoint was set by Bob
    if (notificationMode === 'bobOnly') {
      if (!isBobSetBreakpoint(info.file, info.line)) {
        return false;
      }
    }

    // If we reach here, either mode is "all" or mode is "bobOnly" and breakpoint was set by Bob
    if (!bobExportsRef) {
      console.log('[Bob - PowerToys] No Bob exports available');
      return false;
    }

    const provider = bobExportsRef?.sidebarProvider;
    if (!provider?.getCurrentTask) {
      console.log('[Bob - PowerToys] No provider access');
      return false;
    }

    const task = provider.getCurrentTask();
    if (!task) {
      console.log('[Bob - PowerToys] No active task - Bob is not in a conversation');
      return false;
    }

    const message = [
      `Breakpoint hit at ${info.file}:${info.line}`
    ].join('\n');

    return await safeNotify(task, message);
  } catch (error) {
    console.error('[Bob - PowerToys] Error notifying Bob:', error);
    return false;
  }
}

/**
 * Flush any queued notifications once Bob is idle again.
 * Call this periodically or hook it to a task event.
 */
export async function flushPendingNotifications(bobExports: any): Promise<void> {
  if (pendingNotifications.length === 0) return;

  const provider = bobExports?.sidebarProvider;
  const task = provider?.getCurrentTask?.();
  if (!task) return;

  const lastMsg = task.clineMessages?.at(-1);
  if (lastMsg?.partial === true) return; // still streaming, wait

  // Drain the queue
  const queued = pendingNotifications.splice(0, pendingNotifications.length);
  const combined = queued.join('\n\n---\n\n');

  await safeNotify(task, combined);
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
                console.error('[Bob - PowerToys] Error resolving frame ID:', error);
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
                  console.error('[Bob - PowerToys] Error processing breakpoint hit:', error);
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