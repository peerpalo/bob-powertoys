# IBM Bob - PowerToys

Native debugging and terminal tools for [IBM Bob AI Assistant](https://bob.ibm.com/).

## What is IBM Bob - PowerToys?

IBM Bob - PowerToys is an IBM Bob extension (extension ID `IBM.bob-code`) that enhances the assistant with direct access to your debugging sessions and terminal output. It also adds quality-of-life improvements: detaching the chat panel to a separate OS window, and automatically restoring the last active task when you reopen the application. Bob can set breakpoints, inspect variables, control execution, and read terminal output: all without manual copy-pasting.

## Features

- **Breakpoint Management**: Set, remove, and list breakpoints with conditions
- **Debug Control**: Step through code, continue, pause, and stop debugging
- **Variable Inspection**: Evaluate expressions and inspect variables at any point
- **Stack Traces**: Get call stacks and navigate frames
- **Terminal Access**: Read and search terminal output
- **Automatic Notifications**: Bob is notified when breakpoints are hit
- **Open Task in New Window**: Detach Bob's chat panel to a separate OS window so you can move it to another monitor
- **Restore Last Task**: Bob automatically reopens the task you were working on when you restart the application

## Installation

### From GitHub Releases (Recommended)

1. Download the latest `.vsix` file from [GitHub Releases](https://github.com/peerpalo/bob-powertoys/releases)
2. Install in IBM Bob:
   - **Option 1**: Open Bob → Extensions → `...` menu → Install from VSIX
   - **Option 2**: Run `bob --install-extension bob-powertoys-X.X.X.vsix`
3. Reload Bob when prompted

### From Source (Development)

1. Clone the repository:
   ```bash
   git clone https://github.com/peerpalo/bob-powertoys.git
   cd bob-powertoys
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Compile TypeScript:
   ```bash
   npm run compile
   ```
4. Press `F5` in Bob to launch the extension in debug mode

## Configuration

The extension provides one configuration setting:

**Breakpoint Notifications** (`breakpointNotifications`)
- `disabled`: Never notify Bob when breakpoints are hit
- `bobOnly` (default): Only notify for breakpoints set through Bob's tools
- `all`: Notify for all breakpoint hits

Access via: Bob Settings > Extensions > IBM Bob - PowerToys

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

https://github.com/user-attachments/assets/2aa249e8-1299-4130-9f02-a5f1c655e921

### Restore Last Task

When you close and reopen the application, Bob automatically reopens the task you were working on. No need to dig through history to find where you left off.

This works silently in the background: the save happens as you use Bob normally, and the restore happens at startup before you even interact with it.

## Available Tools

Bob has access to 23 tools organized in 5 categories:

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