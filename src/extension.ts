import * as vscode from 'vscode';
import { registerDebugConsoleTools } from './tools/debugConsole.js';
import { registerDebugSessionTools } from './tools/debugSession.js';
import { registerTerminalCapture, registerTerminalConsoleTools } from './tools/terminalConsole.js';
import { registerBreakpointTools } from './tools/breakpoints.js';
import { registerDebugControlTools } from './tools/debugControl.js';
import { registerUniverseAnswerTool } from './tools/universeAnswer.js';
import { registerDebugAdapterTracker } from './debugAdapter.js';

const BOB_EXTENSION_ID = 'IBM.bob-code';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  console.log('[Bob - PowerToys] Extension activating...');

  // Register terminal capture
  registerTerminalCapture(context);

  // Create status bar item with loading state
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = '$(loading~spin) Bob - PowerToys';
  statusBarItem.command = 'bob-powertoys.showStatus';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Activate Bob (no-op if already active), then register once it's ready
  const bobExtension = vscode.extensions.getExtension(BOB_EXTENSION_ID);
  if (!bobExtension) {
    console.error('[Bob - PowerToys] Bob extension not found - tools will not be available');
    showStatusBarError();
  } else {
    bobExtension.activate().then(() => registerAllTools(context));
  }

  // Register status command
  context.subscriptions.push(
    vscode.commands.registerCommand('bob-powertoys.showStatus', () => {
      showStatus();
    })
  );
}

function registerAllTools(context: vscode.ExtensionContext) {
  try {
    const bobExports = vscode.extensions.getExtension(BOB_EXTENSION_ID)!.exports;

    if (!bobExports?.registerSource) {
      console.error('[Bob - PowerToys] Bob registerSource API not found');
      console.log('[Bob - PowerToys] Available exports:', Object.keys(bobExports ?? {}));
      return;
    }

    // Register centralized debug adapter tracker (captures debug output and notifies Bob)
    console.log('[Bob - PowerToys] Registering centralized debug adapter tracker...');
    context.subscriptions.push(registerDebugAdapterTracker(bobExports));

    // Register our tool source with Bob
    console.log('[Bob - PowerToys] Registering tool source with Bob...');
    const source = bobExports.registerSource('bob-powertoys', 'Bob - PowerToys');

    if (!source?.registerTool) {
      console.error('[Bob - PowerToys] Source registerTool method not found');
      return;
    }

    // Register all debugging tools
    console.log('[Bob - PowerToys] Registering tools...');
    registerBreakpointTools(source);           // 3 tools
    registerDebugControlTools(source);         // 5 tools
    registerDebugConsoleTools(source);         // 6 tools
    registerDebugSessionTools(source);         // 4 tools
    registerTerminalConsoleTools(source);      // 4 tools
    registerUniverseAnswerTool(source);        // 1 tool

    console.log('[Bob - PowerToys] Successfully registered 23 tools with Bob');
    console.log('[Bob - PowerToys] Automatic breakpoint notifications enabled');

    if (statusBarItem) {
      statusBarItem.text = '$(debug-alt) Bob - PowerToys';
    }
  } catch (error) {
    console.error('[Bob - PowerToys] Error registering tools:', error);
    showStatusBarError();
  }
}

function showStatusBarError() {
  if (statusBarItem) {
    statusBarItem.text = '$(error) Bob - PowerToys';
  }
}

function showStatus() {
  const activeSession = vscode.debug.activeDebugSession;
  const sessionName = activeSession ? activeSession.name : 'None';

  const status = [
    'IBM Bob - PowerToys:',
    '- Total Tools Registered: 23',
    '- Automatic Breakpoint Notifications: Enabled',
    '- Active Debug Session: ' + sessionName,
    '- Breakpoints: ' + vscode.debug.breakpoints.length,
    '- Open Terminals: ' + vscode.window.terminals.length,
    '',
    'All tools are now available to Bob AI assistant.',
    'Bob will be automatically notified when breakpoints are hit.'
  ].join('\n');

  vscode.window.showInformationMessage(status, { modal: true });
}

export function deactivate() {
  statusBarItem?.dispose();
  console.log('[Bob - PowerToys] Extension deactivated');
}
