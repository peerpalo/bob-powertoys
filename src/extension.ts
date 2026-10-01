import * as vscode from 'vscode';
import { registerDebugConsoleTools } from './tools/debugConsole.js';
import { registerDebugSessionTools } from './tools/debugSession.js';
import { registerTerminalCapture, registerTerminalConsoleTools } from './tools/terminalConsole.js';
import { registerBreakpointTools } from './tools/breakpoints.js';
import { registerDebugControlTools } from './tools/debugControl.js';
import { registerUniverseAnswerTool } from './tools/universeAnswer.js';
import { registerWorkspaceTools, registerWebviewToolNamePatch } from './tools/workspace.js';
import { registerBobExtensionsTools } from './tools/bobExtensions.js';
import { registerVideoTools } from './tools/videos.js';
import { registerDebugAdapterTracker } from './debugAdapter.js';
import { registerTaskManager, EXTENSION_ID, EXTENSION_DISPLAY_NAME, logger, isAreaEnabled } from './utils.js';
import { registerTaskCommands, registerTaskPersistence, restoreTasks } from './taskManager.js';

const BOB_EXTENSION_ID = 'IBM.bob-code';
const SHOW_STATUS_COMMAND = `${EXTENSION_ID}.showStatus`;
const RELOAD_COMMAND = `${EXTENSION_ID}.reload`;

let statusBarItem: vscode.StatusBarItem;
let registeredTools: any[] = [];

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
  const WIPE_BEFORE_VERSION = '0.8.3';
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

  // Log when a tool area setting changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      for (const area of ['Debug', 'Terminal', 'Workspace', 'Video', 'Extensions']) {
        if (e.affectsConfiguration(`tools.enable${area}`)) {
          logger.log(`${area} tools ${isAreaEnabled(area) ? 'enabled' : 'disabled'}`);
        }
      }
    })
  );
}

async function registerPowerToys(context: vscode.ExtensionContext, bobExports: any) {
  try {
    if (!bobExports?.registerSource) {
      logger.error('Bob registerSource API not found');
      showStatusBarError();
      return;
    }

    const source = bobExports.registerSource(EXTENSION_ID, EXTENSION_DISPLAY_NAME);
    // The public registerSource wrapper drops the 3rd arg (firstParty) — set directly.
    // Without firstParty=true, any Bob build that calls setDisabledSources() will put
    // this source in _disabledSources: sourceIsEnabled() returns false, no tools appear.
    source.firstParty = true;

    if (!source?.registerTool) {
      logger.error('Source registerTool method not found');
      showStatusBarError();
      return;
    }

    // Intercept registerTool to collect every tool instance as it is registered.
    // showStatus() uses the list to count active tools via enabled() at display time.
    registeredTools = [];
    const bobRegisterTool = source.registerTool.bind(source);
    source.registerTool = (tool: any) => { registeredTools.push(tool); bobRegisterTool(tool); };

    registerBreakpointTools(source);           // 3 tools
    registerDebugControlTools(source);         // 5 tools
    registerDebugConsoleTools(source);         // 6 tools
    registerDebugSessionTools(source);         // 4 tools
    registerTerminalConsoleTools(source);      // 4 tools
    registerUniverseAnswerTool(source);        // 1 tool
    registerWorkspaceTools(source);            // 11 tools (10 + read_workspace_video_file)
    registerBobExtensionsTools(source);        // 1 tool
    registerVideoTools(source);                // 1 tool
    logger.log(`Successfully registered ${registeredTools.length} tools with Bob`);

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
  // Count tools whose enabled() returns true at this moment.
  // enabled() already encodes all conditions (area setting + isMultiRoot for workspace tools).
  const toolCount = registeredTools.filter(t => t.enabled?.() !== false).length;

  const notificationsState = isAreaEnabled('Debug') ? 'Enabled' : 'Disabled (debug area off)';

  const status = [
    `${EXTENSION_DISPLAY_NAME}:`,
    '',
    `- Tools Active: ${toolCount}`,
    `- Automatic Breakpoint Notifications: ${notificationsState}`,
    '- Active Debug Session: ' + sessionName,
    '- Breakpoints: ' + vscode.debug.breakpoints.length,
    '- Open Terminals: ' + vscode.window.terminals.length,
    '',
    'Disabled areas: ' + (['Debug', 'Terminal', 'Workspace', 'Video', 'Extensions']
      .filter(a => !isAreaEnabled(a))
      .join(', ') || 'none'),
  ].join('\n');

  vscode.window.showInformationMessage(status, { modal: true });
}

export function deactivate() {
  statusBarItem?.dispose();
  logger.log('Extension deactivated');
}
