import { registerBreakpointTools } from './breakpoints.js';
import { registerDebugControlTools } from './debugControl.js';
import { registerDebugConsoleTools } from './debugConsole.js';
import { registerDebugSessionTools } from './debugSession.js';
import { registerTerminalConsoleTools } from './terminalConsole.js';
import { registerUniverseAnswerTool } from './universeAnswer.js';
import { registerWorkspaceTools } from './workspace.js';

/**
 * Register all tools with Bob's source registry.
 * Note: This function is not currently used as extension.ts registers tools directly,
 * but it's kept for consistency and potential future use.
 *
 * Total: 29 tools + automatic breakpoint notifications
 */
export function registerAllTools(source: any) {
  registerBreakpointTools(source);           // 3 tools
  registerDebugControlTools(source);         // 5 tools
  registerDebugConsoleTools(source);         // 6 tools
  registerDebugSessionTools(source);         // 4 tools (includes automatic breakpoint notifications)
  registerTerminalConsoleTools(source);      // 4 tools
  registerUniverseAnswerTool(source);        // 1 tool
  registerWorkspaceTools(source);            // 6 tools
}
