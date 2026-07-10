import * as vscode from 'vscode';
import { registerDebugConsoleTools } from './tools/debugConsole.js';
import { registerDebugSessionTools } from './tools/debugSession.js';
import { registerTerminalCapture, registerTerminalConsoleTools } from './tools/terminalConsole.js';
import { registerBreakpointTools } from './tools/breakpoints.js';
import { registerDebugControlTools } from './tools/debugControl.js';
import { registerUniverseAnswerTool } from './tools/universeAnswer.js';
import { registerWorkspaceTools } from './tools/workspace.js';
import { registerDebugAdapterTracker } from './debugAdapter.js';
import { registerTaskManager, EXTENSION_ID, EXTENSION_DISPLAY_NAME, logger } from './utils.js';
import { registerTaskCommands, registerTaskPersistence, restoreTasks } from './taskManager.js';

const BOB_EXTENSION_ID = 'IBM.bob-code';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  logger.log('Extension activating...');

  // Register terminal capture
  registerTerminalCapture(context);

  // Create status bar item with loading state
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = `$(loading~spin) ${EXTENSION_DISPLAY_NAME}`;
  statusBarItem.command = `${EXTENSION_ID}.showStatus`;
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
    vscode.commands.registerCommand(`${EXTENSION_ID}.showStatus`, () => {
      showStatus();
    })
  );

  // Register reload command — triggered from the status bar when in error state
  context.subscriptions.push(
    vscode.commands.registerCommand(`${EXTENSION_ID}.reload`, () => {
      const ext = vscode.extensions.getExtension(BOB_EXTENSION_ID);
      if (!ext) {
        vscode.window.showErrorMessage(`[${EXTENSION_DISPLAY_NAME}] Bob extension not found — cannot reload.`);
        return;
      }
      statusBarItem.text = `$(loading~spin) ${EXTENSION_DISPLAY_NAME}`;
      statusBarItem.command = `${EXTENSION_ID}.showStatus`;
      statusBarItem.tooltip = undefined;
      ext.activate().then(() => {
        registerPowerToys(context, ext.exports);
      });
    })
  );

  // Register task window commands
  registerTaskCommands(context);
}

async function registerPowerToys(context: vscode.ExtensionContext, bobExports: any) {
  try {
    logger.log('Registering taskManager...');
    await registerTaskManager(bobExports);

    // Persistence must be registered first so the openTask patch is in place
    // before restoreTasks calls openTaskInNewTab - otherwise the onDispose hooks
    // for restored tabs would never be registered.
    registerTaskPersistence(context);
    await restoreTasks(context);

    if (!bobExports?.registerSource) {
      logger.error('Bob registerSource API not found');
      logger.log('Available exports:', Object.keys(bobExports ?? {}));
      return;
    }

    // Register centralized debug adapter tracker (captures debug output and notifies Bob)
    logger.log('Registering centralized debug adapter tracker...');
    context.subscriptions.push(registerDebugAdapterTracker(bobExports));

    // Register our tool source with Bob
    logger.log('Registering tool source with Bob...');
    const source = bobExports.registerSource(EXTENSION_ID, EXTENSION_DISPLAY_NAME);

    if (!source?.registerTool) {
      logger.error('Source registerTool method not found');
      return;
    }

    // Register all debugging tools
    logger.log('Registering tools...');
    registerBreakpointTools(source);           // 3 tools
    registerDebugControlTools(source);         // 5 tools
    registerDebugConsoleTools(source);         // 6 tools
    registerDebugSessionTools(source);         // 4 tools
    registerTerminalConsoleTools(source);      // 4 tools
    registerUniverseAnswerTool(source);        // 1 tool
    registerWorkspaceTools(source);            // 6 tools

    logger.log('Successfully registered 30 tools with Bob');
    logger.log('Automatic breakpoint notifications enabled');

    if (statusBarItem) {
      statusBarItem.text = `$(debug-alt) ${EXTENSION_DISPLAY_NAME}`;
      statusBarItem.command = `${EXTENSION_ID}.showStatus`;
      statusBarItem.tooltip = undefined;
    }
  } catch (error) {
    logger.error('Error registering tools:', error);
    showStatusBarError();
  }
}

function showStatusBarError() {
  if (statusBarItem) {
    statusBarItem.text = `$(error) ${EXTENSION_DISPLAY_NAME}`;
    statusBarItem.command = `${EXTENSION_ID}.reload`;
    statusBarItem.tooltip = `${EXTENSION_DISPLAY_NAME} failed to load — click to retry`;
  }
}

function showStatus() {
  const activeSession = vscode.debug.activeDebugSession;
  const sessionName = activeSession ? activeSession.name : 'None';

  const status = [
    `${EXTENSION_DISPLAY_NAME}:`,
    '',
    '- Total Tools Registered: 30',
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
