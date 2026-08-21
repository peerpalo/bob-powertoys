import * as vscode from 'vscode';
import { registerDebugConsoleTools } from './tools/debugConsole.js';
import { registerDebugSessionTools } from './tools/debugSession.js';
import { registerTerminalCapture, registerTerminalConsoleTools } from './tools/terminalConsole.js';
import { registerBreakpointTools } from './tools/breakpoints.js';
import { registerDebugControlTools } from './tools/debugControl.js';
import { registerUniverseAnswerTool } from './tools/universeAnswer.js';
import { registerWorkspaceTools, registerWebviewToolNamePatch } from './tools/workspace.js';
import { registerDebugAdapterTracker } from './debugAdapter.js';
import { registerTaskManager, EXTENSION_ID, EXTENSION_DISPLAY_NAME, logger } from './utils.js';
import { registerTaskCommands, registerTaskPersistence, restoreTasks } from './taskManager.js';

const BOB_EXTENSION_ID = 'IBM.bob-code';
const SHOW_STATUS_COMMAND = `${EXTENSION_ID}.showStatus`;
const RELOAD_COMMAND = `${EXTENSION_ID}.reload`;

let statusBarItem: vscode.StatusBarItem;

/**
 * Derives a migration flag key from a version string, e.g. "0.6.9" → "bob-powertoys.migration.069.done".
 * Bump the `WIPE_BEFORE_VERSION` constant below to schedule a new wipe on the next release.
 */
function migrationKey(version: string): string {
  return `${EXTENSION_ID}.migration.${version.replace(/\./g, '')}.done`;
}

/**
 * One-time wipe of all globalState keys for every installed version that is
 * older than WIPE_BEFORE_VERSION (inclusive). Once the flag is set it never
 * runs again, regardless of what the current package version is.
 */
async function migrateGlobalState(context: vscode.ExtensionContext): Promise<void> {
  const WIPE_BEFORE_VERSION = '0.7.0';
  const flagKey = migrationKey(WIPE_BEFORE_VERSION);
  if (context.globalState.get<boolean>(flagKey)) { return; }

  const currentVersion: string = context.extension.packageJSON.version ?? 'unknown';
  const keys = context.globalState.keys();
  logger.log(`globalState migration (current: v${currentVersion}, wipe threshold: v${WIPE_BEFORE_VERSION}): wiping ${keys.length} key(s)`);
  await Promise.all(keys.map(k => context.globalState.update(k, undefined)));
  await context.globalState.update(flagKey, true);
}

export function activate(context: vscode.ExtensionContext) {
  logger.log('Extension activating...');
  migrateGlobalState(context); // fire-and-forget; runs before any task restore

  // Register terminal capture
  registerTerminalCapture(context);

  // Create status bar item with loading state
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = `$(loading~spin) ${EXTENSION_DISPLAY_NAME}`;
  statusBarItem.command = SHOW_STATUS_COMMAND;
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Activate Bob (no-op if already active), then register once it's ready
  const bobExtension = vscode.extensions.getExtension(BOB_EXTENSION_ID);
  if (!bobExtension) {
    logger.error('Bob extension not found - tools will not be available');
    showStatusBarError();
  } else {
    bobExtension.activate().then(() => {
      registerPowerToys(context, bobExtension.exports);
    });
  }

  // Register status command
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_STATUS_COMMAND, () => {
      showStatus();
    })
  );

  // Register reload command — triggered from the status bar when in error state
  context.subscriptions.push(
    vscode.commands.registerCommand(RELOAD_COMMAND, () => {
      const bobExtension = vscode.extensions.getExtension(BOB_EXTENSION_ID);
      if (!bobExtension) {
        vscode.window.showErrorMessage(`[${EXTENSION_DISPLAY_NAME}] Bob extension not found — cannot reload.`);
        return;
      }
      statusBarItem.text = `$(loading~spin) ${EXTENSION_DISPLAY_NAME}`;
      statusBarItem.command = SHOW_STATUS_COMMAND;
      statusBarItem.tooltip = undefined;
      bobExtension.activate().then(() => {
        registerPowerToys(context, bobExtension.exports);
      });
    })
  );

  // Register task window commands
  registerTaskCommands(context);
}

async function registerPowerToys(context: vscode.ExtensionContext, bobExports: any) {
  try {
    if (!bobExports?.registerSource) {
      logger.error('Bob registerSource API not found');
      showStatusBarError();
      return;
    }

    const source = bobExports.registerSource(EXTENSION_ID, EXTENSION_DISPLAY_NAME);

    if (!source?.registerTool) {
      logger.error('Source registerTool method not found');
      showStatusBarError();
      return;
    }

    registerBreakpointTools(source);           // 3 tools
    registerDebugControlTools(source);         // 5 tools
    registerDebugConsoleTools(source);         // 6 tools
    registerDebugSessionTools(source);         // 4 tools
    registerTerminalConsoleTools(source);      // 4 tools
    registerUniverseAnswerTool(source);        // 1 tool
    registerWorkspaceTools(source);            // 10 tools
    logger.log('Successfully registered 31 tools with Bob');

    await completeRegisterPowerToys(context, bobExports, source);
  } catch (error) {
    logger.error('Error registering tools:', error);
    showStatusBarError();
  }
}

/**
 * Completes the parts of setup that require Bob to be logged in
 * (registerTaskManager, debug adapter tracker, task persistence).
 * If Bob is not yet logged in, registers source.onEntitlementChange to retry.
 * Safe to call multiple times — bails out immediately once setup is done.
 */
async function completeRegisterPowerToys(
  context: vscode.ExtensionContext,
  bobExports: any,
  source: any
) {
  try {
    await registerTaskManager(bobExports);
  } catch {
    logger.warn('Bob not ready (not logged in?) — will retry on entitlement change...');
    showStatusBarError();

    // source.onEntitlementChange fires when Bob logs in and re-evaluates
    // entitlements. Use it (once) to retry the login-dependent setup.
    // onEntitlementChange's addListener has a dead-code bug in the current Bob
    // build — the dispose function is written after a return statement and is
    // never actually returned. The callback receives no disposable, so we use
    // the fired flag as the sole one-shot guard instead.
    let fired = false;
    source.onEntitlementChange(() => {
      if (fired) { return; }
      fired = true;
      completeRegisterPowerToys(context, bobExports, source);
    });
    return;
  }

  // Persistence must be registered before restoreTasks so the openTask patch
  // is in place before any openTaskInNewTab calls.
  registerTaskPersistence(context);
  await restoreTasks(context);

  registerWebviewToolNamePatch();
  context.subscriptions.push(registerDebugAdapterTracker(bobExports));
  logger.log('Automatic breakpoint notifications enabled');

  if (statusBarItem) {
    statusBarItem.text = `$(debug-alt) ${EXTENSION_DISPLAY_NAME}`;
    statusBarItem.command = SHOW_STATUS_COMMAND;
    statusBarItem.tooltip = undefined;
  }
}

function showStatusBarError() {
  if (statusBarItem) {
    statusBarItem.text = `$(error) ${EXTENSION_DISPLAY_NAME}`;
    statusBarItem.command = RELOAD_COMMAND;
    statusBarItem.tooltip = `${EXTENSION_DISPLAY_NAME} failed to load — click to retry`;
  }
}

function showStatus() {
  const activeSession = vscode.debug.activeDebugSession;
  const sessionName = activeSession ? activeSession.name : 'None';

  const status = [
    `${EXTENSION_DISPLAY_NAME}:`,
    '',
    '- Total Tools Registered: 31',
    '- Automatic Breakpoint Notifications: Enabled',
    '- Active Debug Session: ' + sessionName,
    '- Breakpoints: ' + vscode.debug.breakpoints.length,
    '- Open Terminals: ' + vscode.window.terminals.length,
    '',
    'All tools are now available to Bob.',
    'Bob will be automatically notified when breakpoints are hit.'
  ].join('\n');

  vscode.window.showInformationMessage(status, { modal: true });
}

export function deactivate() {
  statusBarItem?.dispose();
  logger.log('Extension deactivated');
}
