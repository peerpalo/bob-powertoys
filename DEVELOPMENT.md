# Bob PowerToys Development Guide

## Project Overview

IBM Bob - PowerToys is a IBM Bob extension that gives Bob direct access to your debugging sessions and terminal output. Bob can set breakpoints, inspect variables, control execution, and read terminal output: all without you having to copy-paste information.

## Project Structure

```
bob-powertoys/
├── src/
│   ├── extension.ts              # Extension entry point and Bob integration
│   ├── debugAdapter.ts           # Centralized debug adapter tracker
│   └── tools/                    # Individual tool modules
│       ├── index.ts              # Exports all tools
│       ├── utils.ts              # Shared utilities (JSON parsing, frame resolution)
│       ├── breakpoints.ts        # Breakpoint management (batch operations)
│       ├── debugControl.ts       # Debug stepping & control
│       ├── debugConsole.ts       # Debug console & variable inspection
│       ├── debugSession.ts       # Debug session management
│       ├── terminalConsole.ts    # Terminal output capture & search
│       └── universeAnswer.ts     # Easter egg tool
├── out/                          # Compiled JavaScript output
├── .vscode/
│   ├── launch.json               # Debug configurations
│   └── tasks.json                # Build tasks
├── package.json                  # Extension manifest and dependencies
├── tsconfig.json                 # TypeScript configuration
├── README.md                     # User documentation
└── DEVELOPMENT.md                # This file
```

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                Bob Extension: Bob PowerToys                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐         ┌────────────────────────────┐  │
│  │  Bob Native API  │         │  Centralized Debug Adapter │  │
│  │  registerSource  │         │  - Output capture          │  │
│  │                  │         │  - State tracking          │  │
│  │  Tool Registry   │◄────────┤  - Breakpoint notifications│  │
│  └────────┬─────────┘         └────────────────────────────┘  │
│           │                              ▲                      │
│           │                              │                      │
│           │                    ┌─────────┴──────────┐          │
│           │                    │  VSCode APIs       │          │
│           │                    │  - Debug API (DAP) │          │
│           │                    │  - Terminal API    │          │
│           │                    │  - Workspace API   │          │
│           │                    └────────────────────┘          │
│           │                                                     │
└───────────┼─────────────────────────────────────────────────────┘
            │
            │ Bob's Native Tool Interface
            │ Direct integration via registerSource
            │ + Automatic breakpoint notifications
            │
   ┌────────▼────────┐
   │  Bob Assistant  │
   │  (AI Assistant) │
   └─────────────────┘
```

### Extension Lifecycle

```typescript
activate()
    ↓
registerTerminalCapture()     // Terminal shell execution tracking
    ↓
Wait for Bob extension to activate
    ↓
Get Bob extension exports
    ↓
registerDebugAdapterTracker() // Centralized DAP event tracking + notifications
    ↓
Call bobExports.registerSource('bob-powertoys', 'Bob PowerToys')
    ↓
Register all 23 tools with the source
    ↓
Tools available for Bob immediately
    ↓
Automatic breakpoint notifications enabled
    ↓
deactivate() → Cleanup
```

### Bob Native API Integration

```typescript
// Get Bob extension
const bobExtension = vscode.extensions.getExtension('IBM.bob-code');

// Wait for activation if needed
if (!bobExtension?.isActive) {
  const disposable = vscode.extensions.onDidChange(() => {
    const ext = vscode.extensions.getExtension('IBM.bob-code');
    if (ext?.isActive) {
      disposable.dispose();
      registerAllTools(context);
    }
  });
} else {
  registerAllTools(context);
}

// Register tools
function registerAllTools(context: vscode.ExtensionContext) {
  const bobExports = bobExtension.exports;
  
  // Register centralized debug adapter tracker
  const debugAdapterDisposable = registerDebugAdapterTracker(bobExports);
  context.subscriptions.push(debugAdapterDisposable);
  
  const source = bobExports.registerSource('bob-powertoys', 'Bob PowerToys');
  
  // Register each tool
  registerBreakpointTools(source);
  registerDebugControlTools(source);
  registerDebugConsoleTools(source);
  registerDebugSessionTools(source);
  registerTerminalConsoleTools(source);
  registerUniverseAnswerTool(source);
}
```

## Configuration Settings

### breakpointNotifications

Controls when Bob is automatically notified about breakpoint hits.

**Values:**
- `disabled`: Never notify Bob when breakpoints are hit
- `bobOnly` (default): Only notify for breakpoints set through Bob's tools
- `all`: Notify for all breakpoint hits regardless of source

**Access:** Bob Settings > Extensions > IBM Bob - PowerToys

**Implementation Details:**

1. **Configuration in package.json:**
```json
{
  "configuration": {
    "title": "IBM Bob - PowerToys",
    "properties": {
      "breakpointNotifications": {
        "type": "string",
        "enum": ["disabled", "bobOnly", "all"],
        "enumDescriptions": [
          "Never notify Bob when breakpoints are hit",
          "Only notify Bob for breakpoints set through Bob's tools (default)",
          "Notify Bob for all breakpoint hits, regardless of how they were set"
        ],
        "default": "bobOnly",
        "description": "Controls when Bob is automatically notified about breakpoint hits"
      }
    }
  }
}
```

2. **Breakpoint Source Tracking (breakpoints.ts):**
```typescript
// Set of breakpoints that were set by Bob (via set_breakpoints tool)
// Format: "file:line" (normalized file path)
const bobSetBreakpoints = new Set<string>();

// Check if a breakpoint was set by Bob
export function isBobSetBreakpoint(file: string, line: number): boolean {
  const normalizedFile = path.normalize(file);
  const key = `${normalizedFile}:${line}`;
  return bobSetBreakpoints.has(key);
}

// Mark a breakpoint as set by Bob (called in SetBreakpointsTool)
function markAsBobSet(file: string, line: number): void {
  const normalizedFile = path.normalize(file);
  const key = `${normalizedFile}:${line}`;
  bobSetBreakpoints.add(key);
}

// Unmark a breakpoint (called in RemoveBreakpointsTool)
function unmarkAsBobSet(file: string, line: number): void {
  const normalizedFile = path.normalize(file);
  const key = `${normalizedFile}:${line}`;
  bobSetBreakpoints.delete(key);
}
```

3. **Notification Logic (debugAdapter.ts):**
```typescript
async function notifyBobOfBreakpointHit(
  info: { file: string; line: number; stackTrace: any; variables: any; output: string }
): Promise<boolean> {
  // Read configuration setting
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
  // ... proceed with notification
}
```

**Use Cases:**
- **disabled**: User wants complete control, no automatic notifications
- **bobOnly** (default): Prevents notification spam from user-set breakpoints while still notifying for Bob-assisted debugging
- **all**: User wants comprehensive debugging awareness, Bob notified for every breakpoint hit

## Detailed Tool Documentation

### Breakpoint Management Tools

#### set_breakpoints
Set multiple breakpoints at once with optional conditions.

**Parameters:**
```json
{
  "breakpoints": [
    {
      "file": "/path/to/file.ts",
      "line": 42,
      "condition": "x > 10"
    }
  ]
}
```

**Returns:**
```json
{
  "summary": "2 set, 0 warnings",
  "details": [
    {
      "file": "src/app.ts",
      "line": 42,
      "status": "success",
      "message": "Set with condition: x > 10"
    }
  ]
}
```

**Implementation Notes:**
- Automatically marks breakpoints as "Bob-set" for notification filtering
- Uses `markAsBobSet()` after successful verification
- Supports batch operations for efficiency

#### remove_breakpoints
Remove multiple breakpoints by file and line.

**Parameters:**
```json
{
  "breakpoints": [
    {
      "file": "/path/to/file.ts",
      "line": 42
    }
  ]
}
```

**Implementation Notes:**
- Automatically unmarks breakpoints using `unmarkAsBobSet()`
- Cleans up tracking state when breakpoints are removed

#### list_breakpoints
List all active breakpoints.

**Parameters:** None

**Returns:**
```json
{
  "count": 2,
  "breakpoints": [
    {
      "file": "src/app.ts",
      "line": 42,
      "condition": "x > 10",
      "verified": true
    }
  ]
}
```

### Debug Control Tools

All debug control tools return structured JSON:
```json
{
  "action": "step_over",
  "status": "success",
  "session": "Node: Launch Program"
}
```

- **step_over**: Step over current line
- **step_into**: Step into function call
- **step_out**: Step out of current function
- **continue**: Continue execution until next breakpoint
- **pause**: Pause execution

### Debug Console & Inspection Tools

#### evaluate_expression
Evaluate expression with automatic frame resolution.

**Parameters:**
```json
{
  "expression": "myVariable + 10",
  "frameId": 0,
  "context": "repl",
  "expand": true
}
```

- `frameId` (optional): Frame to evaluate in (0 = auto-resolve to top frame)
- `context` (optional): "repl", "watch", or "hover"
- `expand` (optional): Auto-expand object references

#### get_variables
Get variables from a variables reference.

**Parameters:**
```json
{
  "variablesReference": 1001,
  "filter": "named"
}
```

#### get_stack_trace
Get call stack with automatic thread resolution.

**Parameters:**
```json
{
  "threadId": 1,
  "startFrame": 0,
  "levels": 20
}
```

- `threadId` (optional): Thread to get stack from (auto-resolves to current)

#### get_scopes
Get variable scopes with automatic frame resolution.

**Parameters:**
```json
{
  "frameId": 0
}
```

- `frameId` (optional): Frame to get scopes from (0 = auto-resolve)

#### set_variable
Modify a variable's value during debugging.

**Parameters:**
```json
{
  "variablesReference": 1001,
  "name": "myVariable",
  "value": "42"
}
```

#### get_debug_output
Get captured debug console output.

**Parameters:**
```json
{
  "lines": 100,
  "category": "console"
}
```

- Categories: "console", "stdout", "stderr"

### Debug Session Management Tools

#### get_active_debug_session
Get information about the active debug session.

**Parameters:** None

**Returns:**
```json
{
  "name": "Node: Launch Program",
  "type": "node",
  "id": "session-id"
}
```

#### list_debug_configurations
List all debug configurations from launch.json.

**Parameters:** None

**Returns:**
```json
{
  "configurations": [
    {
      "name": "Launch Program",
      "type": "node",
      "request": "launch"
    }
  ]
}
```

#### start_debug_session
Start debugging with smart configuration selection.

**Parameters:**
```json
{
  "configName": "Launch Program",
  "context": "node app.js"
}
```

- `configName` (optional): Specific config to use
- `context` (optional): Helps select best config automatically

**Smart Selection Logic:**
1. If `configName` provided: exact match
2. If only one config: use it
3. If multiple configs with `context`:
   - Match by name
   - Match by config content (program, cwd, etc.)
   - Prefer "attach" if context mentions running process
4. Default: prefer "launch" over "attach"

#### stop_debug_session
Stop the active debug session.

**Parameters:** None

### Terminal Console Tools

#### list_terminals
List all open terminals with status.

**Parameters:** None

**Returns:**
```json
{
  "terminals": [
    {
      "name": "bash",
      "active": true,
      "hasOutput": true
    }
  ]
}
```

#### get_terminal_output
Get recent terminal output (max 200 characters).

**Parameters:**
```json
{
  "terminalName": "bash",
  "maxChars": 200
}
```

- `terminalName` (optional): Defaults to active terminal
- Output is ANSI-stripped for clean reading
- Returns last N characters (not lines)

#### search_terminal_output
Search terminal output with regex pattern.

**Parameters:**
```json
{
  "query": "error|warning",
  "terminalName": "bash",
  "maxChars": 200
}
```

- Case-insensitive regex search
- Returns matching content up to character limit

#### focus_terminal
Bring a terminal into focus.

**Parameters:**
```json
{
  "terminalName": "bash"
}
```

## Key Components

### 1. extension.ts (~150 lines)

**Purpose**: Extension lifecycle management and Bob integration

**Key Functions**:
- `activate()`: Entry point, registers event captures and Bob tools
- `registerAllTools()`: Registers all 23 tools with Bob's source and centralized debug adapter
- `registerTerminalCapture()`: Captures terminal output via shell execution events

**Bob Integration**:
- Waits for Bob extension to activate
- Gets Bob's public API via `exports`
- Registers centralized debug adapter tracker
- Creates tool source with `registerSource()`
- Registers all tools with the source

### 2. debugAdapter.ts (~220 lines)

**Purpose**: Centralized debug adapter tracker for state management and automatic notifications

**Key Features**:
- **Single source of truth**: Eliminates race conditions from duplicate trackers
- **Shared state**: `currentStoppedState` used by all debug tools
- **Output capture**: Captures debug console output via DAP events
- **Automatic notifications**: Notifies Bob when breakpoints are hit
- **Smart queueing**: Queues notifications during Bob's streaming

**Exported Functions**:
```typescript
export function getCurrentStoppedState(): { threadId: number; frameId?: number } | undefined
export function getRecentDebugOutput(lineCount: number = 20): string
export function registerDebugAdapterTracker(bobExports: any): vscode.Disposable
export async function flushPendingNotifications(bobExports: any): Promise<void>
```

**Notification System**:
```typescript
async function safeNotify(task: any, message: string): Promise<boolean> {
  // Check if Bob is idle or actively working
  const isIdle = !task.isStreaming && !task.isWaitingForFirstChunk;
  
  // Queue if streaming or not idle
  if (lastMsg?.partial === true || !isIdle) {
    pendingNotifications.push(message);
    return false;
  }
  
  // Submit message when Bob is idle
  await task.submitUserMessage(message, []);
  return true;
}
```

**Breakpoint Hit Detection**:
- Listens for DAP `stopped` events with `reason: 'breakpoint'`
- Fetches stack trace and local variables
- Calls `notifyBobOfBreakpointHit()` with breakpoint info
- Message format: `Breakpoint hit at file:line`

### 3. tools/utils.ts (~80 lines)

**Purpose**: Shared utility functions for all tools

**Key Functions**:
```typescript
// Parse JSON string parameters from Bob
export function parseJsonParameter<T>(param: string | T, paramName: string): T

// Resolve frame ID with validation (must be > 0)
export async function resolveFrameId(
  frameId: number | undefined | null,
  resolveTopFrame: () => Promise<number | undefined>
): Promise<number | undefined>
```

**Why Needed**:
- Bob sends complex parameters (arrays, objects) as JSON strings
- Frame IDs <= 0 are invalid and need resolution to top frame
- Centralized error handling for parameter parsing

### 4. Bob's Tool Interface

Each tool must implement the following interface:

```typescript
class MyTool {
  static id = 'my_tool';
  groups = ['read']; // or ['edit']
  parameters = [
    {
      name: 'param1',
      required: true,
      type: 'string',
      description: 'Parameter description',
      usage: 'Example usage'
    }
  ];

  getId(): string {
    return MyTool.id;
  }

  getDescription(options?: any): string {
    return `## my_tool
Description: Full description for system prompt

Parameters:
- param1: (required) string. Description

Usage:
<my_tool>
<param1>value</param1>
</my_tool>`;
  }

  getCostEffectiveDescription(): string {
    return 'Brief description for tool selection';
  }

  toolUseDescription(params: any): string {
    return 'Description shown during execution';
  }

  async call(context: {
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    // Implementation
    context.pushResult('Success message');
  }
}
```

### 5. tools/ Directory (Modular Tool Organization)

#### tools/index.ts
**Purpose**: Central registration point for all tools

```typescript
export function registerBreakpointTools(source: any) {
  source.registerTool(new SetBreakpointsTool());
  source.registerTool(new RemoveBreakpointsTool());
  source.registerTool(new ListBreakpointsTool());
}

export function registerDebugControlTools(source: any) {
  source.registerTool(new StepOverTool());
  source.registerTool(new StepIntoTool());
  source.registerTool(new StepOutTool());
  source.registerTool(new ContinueTool());
  source.registerTool(new PauseTool());
}

// ... other tool registrations
```

#### tools/breakpoints.ts
**Tools**: `set_breakpoints`, `remove_breakpoints`, `list_breakpoints`

**Key Features**:
- Batch operations (set/remove multiple breakpoints at once)
- Path normalization and workspace resolution
- Conditional breakpoint support
- Verification of breakpoint addition
- Detailed status reporting

**Implementation Details**:
- Uses `vscode.debug.addBreakpoints()` for batch setting
- Path resolution: absolute paths or workspace-relative
- Verification with 100ms delay for Bob to process
- Returns structured JSON with success/warning status per breakpoint

#### tools/debugControl.ts
**Tools**: `step_over`, `step_into`, `step_out`, `continue`, `pause`

**Key Features**:
- All tools return structured JSON
- Session name included in response
- Consistent error handling

**Implementation Details**:
- Uses `vscode.commands.executeCommand()` for debug actions
- Checks for active debug session before execution
- Returns: `{ action: "step_over", status: "success", session: "..." }`

#### tools/debugConsole.ts
**Tools**: `evaluate_expression`, `get_variables`, `get_stack_trace`, `get_scopes`, `set_variable`, `get_debug_output`

**Key Features**:
- **Centralized state**: Uses `getCurrentStoppedState()` from debugAdapter
- **Auto-resolution**: Automatically resolves frame IDs when not provided
- **Variable expansion**: Automatically expands object references
- **Debug output access**: Gets output via `getRecentDebugOutput()` from debugAdapter

**Implementation Details**:

1. **Using Centralized State**:
```typescript
import { getCurrentStoppedState, getRecentDebugOutput } from '../debugAdapter.js';

async function resolveTopFrameId(session: DebugSession): Promise<number | undefined> {
  const currentStoppedState = getCurrentStoppedState();
  
  // Use cached frame from centralized tracker (fast)
  if (currentStoppedState?.frameId !== undefined) {
    return currentStoppedState.frameId;
  }
  
  // Fallback: query if frame not yet resolved
  if (currentStoppedState?.threadId !== undefined) {
    const stack = await session.customRequest('stackTrace', {
      threadId: currentStoppedState.threadId,
      levels: 1
    });
    return stack.stackFrames[0]?.id;
  }
  
  return undefined; // Not paused
}
```

2. **Frame ID Validation**:
```typescript
// Uses resolveFrameId utility from utils.ts
const resolvedFrameId = await resolveFrameId(
  frameId,
  () => resolveTopFrameId(session)
);

// Only frameId > 0 is valid
if (!resolvedFrameId || resolvedFrameId <= 0) {
  context.pushError('No valid frame available');
  return;
}
```

#### tools/debugSession.ts
**Tools**: `get_active_debug_session`, `list_debug_configurations`, `start_debug_session`, `stop_debug_session`

**Key Features**:
- Smart configuration selection based on context
- JSON5 support via VSCode Configuration API
- Structured JSON responses

**Implementation Details**:

1. **Configuration Reading**:
```typescript
// Uses VSCode API instead of manual JSON parsing
const config = vscode.workspace.getConfiguration('launch', folder.uri);
const configurations = config.get<any[]>('configurations');
```

2. **Smart Config Selection**:
- If `configName` provided: exact match
- If only one config: use it
- If multiple configs with `context`:
  - Match by name
  - Match by config content (program, cwd, etc.)
  - Prefer "attach" if context mentions running process
- Default: prefer "launch" over "attach"

#### tools/terminalConsole.ts
**Tools**: `list_terminals`, `get_terminal_output`, `search_terminal_output`, `focus_terminal`

**Key Features**:
- **Character-based limits** (not line-based)
- **ANSI stripping** for clean AI-readable output
- **Shell integration** via `onDidStartTerminalShellExecution`
- **Terminal object keying** (not name-based)

**Implementation Details**:

1. **Output Capture**:
```typescript
const terminalOutputLog = new Map<vscode.Terminal, string[]>();
const MAX_TERMINAL_OUTPUT_CHARS = 200;

vscode.window.onDidStartTerminalShellExecution(event => {
  const terminal = event.terminal;
  (async () => {
    for await (const chunk of event.execution.read()) {
      // Strip ANSI codes for clean output
      terminalOutputLog.get(terminal)?.push(stripAnsi(chunk));
    }
  })();
});
```

2. **ANSI Stripping**:
```typescript
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[mGKHFJK]/g, '');
}
```

3. **Character-Based Output**:
```typescript
// Join all chunks and take last N characters
const fullOutput = output.join('');
const recentOutput = fullOutput.slice(-MAX_TERMINAL_OUTPUT_CHARS);
```

4. **Search with Character Limit**:
```typescript
// Collect matching lines until char limit reached
for (const line of output) {
  if (regex.test(line) && totalChars + line.length <= maxChars) {
    matches.push(line);
    totalChars += line.length;
  }
}
```

## Complete Tool Reference (23 Tools)

### Breakpoint Tools (3)
1. **set_breakpoints** - Batch set breakpoints with conditions
2. **remove_breakpoints** - Batch remove breakpoints
3. **list_breakpoints** - List all active breakpoints

### Debug Control Tools (5)
4. **step_over** - Step over current line
5. **step_into** - Step into function
6. **step_out** - Step out of function
7. **continue** - Continue execution
8. **pause** - Pause execution

### Debug Console Tools (6)
9. **evaluate_expression** - Evaluate expression with auto frame resolution
10. **get_variables** - Get variables from reference
11. **get_stack_trace** - Get call stack with auto thread resolution
12. **get_scopes** - Get scopes with auto frame resolution
13. **set_variable** - Modify variable value
14. **get_debug_output** - Get captured debug console output

### Debug Session Tools (4)
15. **get_active_debug_session** - Get active session info
16. **list_debug_configurations** - List launch.json configs
17. **start_debug_session** - Start debug with smart config selection
18. **stop_debug_session** - Stop active debug session

### Terminal Console Tools (4)
19. **list_terminals** - List all terminals with status
20. **get_terminal_output** - Get last 200 chars of output
21. **search_terminal_output** - Search output with regex (max 200 chars)
22. **focus_terminal** - Focus terminal by name

### Easter Egg Tool (1)
23. **universe_answer** - Returns the answer to life, the universe, and everything

## Development Setup

### Prerequisites

- Node.js 20.x or higher
- IBM Bob 2.0.0 or higher
- TypeScript 5.3.2 or higher

### Installation

1. Clone the repository
2. Install dependencies: `npm install`
3. Compile: `npm run compile`

### Running the Extension

1. Open project in Bob
2. Press `F5` to launch Extension Development Host
3. Extension loads in new Bob window
4. Tools automatically register with Bob

### Development Workflow

1. **Watch Mode**: `npm run watch` - auto-recompile on changes
2. **Manual Compile**: `npm run compile`
3. **Debugging**: F5 to launch, set breakpoints in extension code
4. **Reload**: `Ctrl+R` / `Cmd+R` in Extension Development Host

## Testing

### Manual Testing

1. Launch extension (F5)
2. Open debuggable project
3. Start debug session
4. Test tools via Bob

### Testing with Bob

1. Launch extension (F5)
2. Ask Bob to use debugging tools
3. Verify responses and behavior

## Adding New Tools

### Step-by-Step Guide

1. **Create tool class** in `src/tools/`:
```typescript
// src/tools/mytools.ts
import * as vscode from 'vscode';

export class MyTool {
  static id = 'my_tool';
  groups = ['read'];
  parameters = [
    {
      name: 'param',
      required: true,
      type: 'string',
      description: 'Parameter description',
      usage: 'Example: "value"'
    }
  ];

  getId(): string {
    return MyTool.id;
  }

  getDescription(options?: any): string {
    return `## my_tool
Description: Tool description

Parameters:
- param: (required) string. Description

Usage:
<my_tool>
<param>value</param>
</my_tool>`;
  }

  getCostEffectiveDescription(): string {
    return 'Brief description';
  }

  toolUseDescription(params: any): string {
    return `Executing my_tool with ${params.param}`;
  }

  async call(context: {
    parameters: { param: string };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    try {
      // Implementation
      const result = { success: true, param: context.parameters.param };
      context.pushResult(JSON.stringify(result, null, 2));
    } catch (error) {
      context.pushError(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function registerMyTools(source: any) {
  source.registerTool(new MyTool());
}
```

2. **Export from index.ts**:
```typescript
import { registerMyTools } from './mytools.js';

export function registerAllTools(source: any) {
  // ... existing
  registerMyTools(source);
}
```

3. **Recompile**: `npm run compile`
4. **Test**: Reload extension and test with Bob

### Tool Best Practices

✅ **DO**:
- Implement all required interface methods
- Return structured JSON for all responses
- Include status/error fields in responses
- Handle edge cases (no session, no terminal, etc.)
- Use descriptive parameter names and descriptions
- Add JSDoc comments for complex logic
- Use `pushResult` for success, `pushError` for errors

❌ **DON'T**:
- Return plain text strings (use JSON)
- Assume resources exist (always check)
- Throw exceptions (use `pushError` instead)
- Skip any interface methods

## Debugging Tips

1. **Extension Logs**: Check Debug Console in Extension Development Host
2. **Tool Logs**: Add `console.log()` in tool handlers
3. **VSCode API**: Use `vscode.window.showInformationMessage()` for quick feedback
4. **Breakpoints**: Set in extension code and debug with F5
5. **DAP Events**: Log messages in `onDidSendMessage` tracker

## Common Development Tasks

### Adding VSCode Command

1. Register in `package.json`:
```json
{
  "command": "bob-powertoys.myCommand",
  "title": "Bob PowerToys: My Command"
}
```

2. Implement in `extension.ts`:
```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('bob-powertoys.myCommand', async () => {
    // Implementation
  })
);
```

### Modifying Tool Behavior

1. Find tool in `src/tools/`
2. Modify `call()` method
3. Recompile: `npm run compile`
4. Reload extension: `Ctrl+R` in Extension Development Host

## Building for Distribution

### Create VSIX Package

```bash
npm install -g @vscode/vsce
vsce package
```

Creates `.vsix` file for installation.

### Publishing

```bash
vsce publish
```

Requires publisher account on VSCode Marketplace.

## Troubleshooting

### Extension doesn't activate
- Check activation events in package.json
- Verify compilation succeeds
- Check Extension Host logs

### Tools don't appear in Bob
- Verify Bob extension is active
- Check that `registerSource` is called
- Review extension activation logs

### Tools don't work
- Ensure debug session active (for debug tools)
- Check parameter types match schema
- Verify VSCode API permissions

### TypeScript errors
- Run `npm install`
- Check tsconfig.json
- Verify @types packages installed

## Code Style Guidelines

- Use TypeScript strict mode
- Implement all tool interface methods
- Return structured JSON from all tools
- Add JSDoc for public APIs
- Keep functions focused and small
- Use meaningful variable names
- Handle errors gracefully with `pushError`
- Follow existing patterns
- Use centralized state from debugAdapter.ts
- Parse JSON parameters with `parseJsonParameter()` utility
- Validate frame IDs with `resolveFrameId()` utility

## Resources

- [VSCode Extension API](https://code.visualstudio.com/api)
- [VSCode Debug API](https://code.visualstudio.com/api/references/vscode-api#debug)
- [VSCode Terminal API](https://code.visualstudio.com/api/references/vscode-api#window.onDidStartTerminalShellExecution)
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)

## License

MIT

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create feature branch
3. Make changes following style guidelines
4. Add tests if applicable
5. Submit pull request

## Support

For issues and questions:
1. Check existing GitHub issues
2. Review documentation
3. Create new issue with details