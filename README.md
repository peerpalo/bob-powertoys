# PowerToys for Bob

Enhanced development tools for [IBM Bob](https://bob.ibm.com/): debugging, terminal access, multi-root workspace support, and quality-of-life improvements.

## What is PowerToys for Bob?

PowerToys for Bob is an IBM Bob extension that **supercharges your development workflow**. It supports multi-root workspaces, letting Bob read, write, and search files across all your workspace folders seamlessly. It adds quality-of-life improvements like detaching the chat panel to a separate OS window and automatically restoring the last active task on reopen. It also gives Bob direct access to your debugging sessions so it can set breakpoints, inspect variables, control execution, and read terminal output: all without manual copy-pasting.

> **Disclaimer:** PowerToys for Bob is a personal project. It is not affiliated with, endorsed by, or supported by IBM.

## Features

- **Breakpoint Management**: Set, remove, and list breakpoints with conditions
- **Debug Control**: Step through code, continue, pause, and stop debugging
- **Variable Inspection**: Evaluate expressions and inspect variables at any point
- **Stack Traces**: Get call stacks and navigate frames
- **Terminal Access**: Read and search terminal output
- **Automatic Breakpoint Notifications**: Bob is notified when breakpoints are hit
- **Multi-Root Workspace Support**: Read, write, and search files across all workspace folders without per-file confirmation prompts
- **Open Task in New Window**: Detach Bob's chat panel to a separate OS window so you can move it to another monitor
- **Restore Last Task**: Bob automatically reopens the task you were working on when you restart the application

## Configuration

The extension provides one configuration setting:

**Breakpoint Notifications** (`breakpointNotifications`)
- `disabled`: Never notify Bob when breakpoints are hit
- `bobOnly` (default): Only notify for breakpoints set through Bob's tools
- `all`: Notify for all breakpoint hits

Access via: Bob Settings > Extensions > PowerToys for Bob

## Usage

Once installed, Bob automatically has access to all debugging and terminal tools. No additional configuration needed.

### Example Conversations

**Natural language debugging - just describe what you want to understand:**

> "I need to debug my API server to understand which user is making the database queries. Can you help me figure that out?"

> "The authentication is failing but I don't know why. Let's debug it and see what's happening with the user credentials"

> "Something's wrong with the payment processing. Can you attach to the checkout service and help me trace through what's happening?"

**Direct debugging requests:**

> "Set a breakpoint in the login handler when username is empty"

> "What's the current value of orderTotal in the shopping cart?"

> "Show me the call stack when the database connection fails"

> "Search the terminal for any TypeScript compilation errors"

## Quality of Life

### Open Task in New Window

Move Bob's chat panel to a separate OS window so you can place it on a second monitor while you keep coding in the main one.

**How to use:**
- Right-click anywhere inside Bob's chat panel and select **Open Task in Window**
- Or open the `...` menu in Bob's toolbar and select **New Task In Window** to start a fresh task in its own window

![Hello, World!](https://raw.githubusercontent.com/peerpalo/bob-powertoys/main/assets/hello-world-new-window.gif)

### Restore Last Task

When you close and reopen the application, Bob automatically reopens the task you were working on. No need to dig through history to find where you left off.

This works silently in the background: the save happens as you use Bob normally, and the restore happens at startup before you even interact with it.

## Multi-Root Workspace Support

When you open a Bob workspace with **multiple root folders at different paths on disk** (e.g. `...\src\frontend` and `...\src\backend` in the same `.code-workspace` file), Bob's built-in tools (`read_file`, `list_files`, `glob`, `grep`) are sandboxed to only the primary folder. Every file in a secondary folder triggers a "allow outside workspace?" confirmation prompt.

PowerToys for Bob solves this by providing nine workspace-aware tools that use the VS Code filesystem API directly, with no sandbox restrictions. The tools are **automatically hidden** in single-root workspaces - they consume no tokens and cannot be called when there is only one folder.

## Available Tools

Bob has access to 32 tools organized in 6 categories:

### Breakpoint Management (3 tools)
- `set_breakpoints` - Set multiple breakpoints with optional conditions
- `remove_breakpoints` - Remove multiple breakpoints
- `list_breakpoints` - List all active breakpoints

### Debug Control (5 tools)
- `step_over` - Step over current line
- `step_into` - Step into function call
- `step_out` - Step out of current function
- `continue` - Continue execution
- `pause` - Pause execution

### Debug Console & Inspection (6 tools)
- `evaluate_expression` - Evaluate expressions in debug context
- `get_variables` - Get variables from a scope
- `get_stack_trace` - Get call stack
- `get_scopes` - Get variable scopes
- `set_variable` - Modify variable values
- `get_debug_output` - Get debug console output

### Debug Session Management (4 tools)
- `get_active_debug_session` - Get active session info
- `list_debug_configurations` - List available debug configs
- `start_debug_session` - Start debugging
- `stop_debug_session` - Stop debugging

### Terminal Console (4 tools)
- `list_terminals` - List all open terminals
- `get_terminal_output` - Get recent terminal output
- `search_terminal_output` - Search terminal with regex
- `focus_terminal` - Bring terminal into focus

### Multi-Root Workspace (9 tools)

> These tools are **only active in multi-root workspaces** (2+ root folders). They are invisible to Bob in single-root workspaces.

- `list_workspace_folders` - List all workspace root folders and their paths
- `read_workspace_file` - Read any file from any workspace folder
- `write_workspace_file` - Write/create any file in any workspace folder
- `list_workspace_files` - List files and directories in any workspace folder
- `glob_workspace` - Find files by glob pattern across workspace folders
- `grep_workspace` - Search file contents by regex across workspace folders
- `insert_workspace_content` - Insert lines at a specific position in any file in any workspace folder
- `search_and_replace_workspace` - Find-and-replace text (literal or regex) in any file in any workspace folder
- `apply_diff_workspace` - Apply a SEARCH/REPLACE diff block to any file using Bob's fuzzy diff engine

For detailed tool documentation and parameters, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Requirements

- IBM Bob 2.0.0 or higher
- Node.js 20.x or higher

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture details, development guide, and contribution guidelines.

## License

MIT

## Author

Pierpaolo Battaglione