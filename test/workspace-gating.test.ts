import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodePath from 'path';
import { registerWorkspaceTools } from '../src/tools/workspace.js';
import { registerTaskManager } from '../src/utils.js';
import { workspace } from './__mocks__/vscode.js';

// The list_workspace_folders tool, the prompt injection and the multi-root
// sandbox patch are all gated by the same condition: a multi-root workspace
// (2+ root folders). There is no dedicated setting anymore.

const primary = nodePath.resolve('/ws/primary');
const secondary = nodePath.resolve('/ws/secondary');
const folder = (name: string, fsPath: string) => ({ name, uri: { fsPath } });

function setFolders(count: 0 | 1 | 2) {
  workspace.workspaceFolders = [folder('primary', primary), folder('secondary', secondary)].slice(0, count);
}

/** Captures what registerWorkspaceTools() registers on a Bob source. */
function fakeSource() {
  const tools: any[] = [];
  const turnStartCallbacks: Array<(taskId: string, envs: any, isEmpty: boolean) => void> = [];
  const didExecuteCallbacks: Array<(env: any, toolId: string, args: any, meta: any) => void> = [];
  return {
    tools,
    turnStart: (...a: [string, any, boolean]) => { for (const cb of turnStartCallbacks) { cb(...a); } },
    registerTool: (t: any) => tools.push(t),
    // Real Bob supports multiple onTurnStart listeners — keep them all.
    onTurnStart: (cb: (taskId: string, envs: any, isEmpty: boolean) => void) => { turnStartCallbacks.push(cb); },
    onToolDidExecute: (cb: (env: any, toolId: string, args: any, meta: any) => void) => { didExecuteCallbacks.push(cb); },
    didExecute: (...a: [any, string, any, any]) => { for (const cb of didExecuteCallbacks) { cb(...a); } },
  };
}

/** Makes getTaskManager()/findTaskChatManager() resolve a task we control. */
async function installFakeTask(taskId: string, task: any) {
  const chatManager = { currentTask: task };
  await registerTaskManager({
    taskManager: { getChatManagerByTaskId: (id: string) => (id === taskId ? chatManager : undefined) },
  });
  return task;
}

beforeEach(() => {
  setFolders(2);
});

afterEach(() => {
  vi.useRealTimers();
  workspace.workspaceFolders = [];
});

describe('list_workspace_folders enabled()', () => {
  it('is enabled in a multi-root workspace', () => {
    const src = fakeSource();
    registerWorkspaceTools(src);
    expect(src.tools).toHaveLength(1);
    expect(src.tools[0].enabled()).toBe(true);
  });

  it.each([0, 1] as const)('is disabled with %i workspace folder(s)', count => {
    const src = fakeSource();
    registerWorkspaceTools(src);
    setFolders(count);
    expect(src.tools[0].enabled()).toBe(false);
  });
});

describe('prompt injection (onTurnStart)', () => {
  async function run(isEmpty = true) {
    vi.useFakeTimers();
    const systemMessage = { role: 'system', content: 'base prompt' };
    await installFakeTask('task-1', { getMessages: () => [systemMessage] });
    const src = fakeSource();
    registerWorkspaceTools(src);
    src.turnStart('task-1', {}, isEmpty);
    await vi.advanceTimersByTimeAsync(100);
    return systemMessage.content;
  }

  it('appends the multi-root block on the first turn of a task', async () => {
    const content = await run();
    expect(content).toContain('<multi_root_workspace>');
    expect(content).toContain(secondary);
  });

  it('lists every workspace folder', async () => {
    const content = await run();
    expect(content).toContain('name="primary"');
    expect(content).toContain('name="secondary"');
  });

  it('documents that built-in tools work on every folder', async () => {
    const content = await run();
    expect(content).toContain('All tools work on files in EVERY folder');
  });

  it('does not inject on resumed turns', async () => {
    expect(await run(false)).toBe('base prompt');
  });

  it('does not inject in a single-root workspace', async () => {
    setFolders(1);
    expect(await run()).toBe('base prompt');
  });
});

describe('multi-root sandbox patch (onTurnStart)', () => {
  it('installs the wraps on the turn task when in a multi-root workspace', async () => {
    const { FakeReadFileTool } = await loadFixtureClasses();
    const tool = new FakeReadFileTool();
    const task = {
      id: 'task-1',
      getTools: () => [tool],
      recordToolCallArguments(tc: any) { return tc; },
    };
    await installFakeTask('task-1', task);

    const src = fakeSource();
    registerWorkspaceTools(src);
    src.turnStart('task-1', {}, true);

    // Simulate Bob's flow: record args, then read the tool schema (sCr).
    task.recordToolCallArguments({ name: 'read_file', id: 'c1', arguments: { path: nodePath.join(secondary, 'a.txt') } });
    const params = tool.getParameters({ id: 'task-1', workspace: primary });
    expect(params[0].usage).toBeUndefined();  // in a workspace folder → tag stripped
  });

  it('strips with parallel calls of other tools pending, but not when a same-tool call is outside', async () => {
    const { FakeReadFileTool } = await loadFixtureClasses();
    const tool = new FakeReadFileTool();
    const task = {
      id: 'task-3',
      getTools: () => [tool],
      recordToolCallArguments(tc: any) { return tc; },
    };
    await installFakeTask('task-3', task);

    const src = fakeSource();
    registerWorkspaceTools(src);
    src.turnStart('task-3', {}, true);
    const env = { id: 'task-3', workspace: primary };
    const inside = { path: nodePath.join(secondary, 'a.txt') };
    const outside = { path: nodePath.join(nodePath.dirname(primary), 'elsewhere', 'b.txt') };

    // Bob records every parallel call before any reaches the sandbox check.
    task.recordToolCallArguments({ name: 'read_file', id: 'c1', arguments: inside });
    task.recordToolCallArguments({ name: 'grep', id: 'c2', arguments: outside });
    expect(tool.getParameters(env)[0].usage).toBeUndefined();

    task.recordToolCallArguments({ name: 'read_file', id: 'c3', arguments: outside });
    expect(tool.getParameters(env)[0].usage).toBe('filePath');

    // Once the outside call finishes it no longer vetoes the strip.
    src.didExecute({}, 'read_file', outside, { taskId: 'task-3' });
    expect(tool.getParameters(env)[0].usage).toBeUndefined();
  });

  it('is a pass-through in a single-root workspace (gate evaluated at call time)', async () => {
    const { FakeReadFileTool } = await loadFixtureClasses();
    const tool = new FakeReadFileTool();
    const task = {
      id: 'task-2',
      getTools: () => [tool],
      recordToolCallArguments(tc: any) { return tc; },
    };
    await installFakeTask('task-2', task);

    const src = fakeSource();
    registerWorkspaceTools(src);
    setFolders(1);
    src.turnStart('task-2', {}, true);

    task.recordToolCallArguments({ name: 'read_file', id: 'c1', arguments: { path: nodePath.join(secondary, 'a.txt') } });
    const params = tool.getParameters({ id: 'task-2', workspace: primary });
    expect(params[0].usage).toBe('filePath');  // native behavior preserved
  });
});

/**
 * Fixture classes mimicking Bob's built-in tools. Defined via dynamic import
 * of a module string so each test file gets its own (unpatched) prototypes.
 */
async function loadFixtureClasses(): Promise<{ FakeReadFileTool: any }> {
  const modUrl = 'data:text/javascript;base64,' + Buffer.from(`
    export class FakeReadFileTool {
      id = 'read_file';
      getParameters(env) { return [{ name: 'path', type: 'string', required: true, usage: 'filePath', detail: 'File path (absolute). The workspace is at ' + env.workspace }]; }
      async call(context) { return context; }
    }
  `, 'utf8').toString('base64');
  return await import(/* @vite-ignore */ modUrl);
}
