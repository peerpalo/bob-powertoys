import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodePath from 'path';
import { registerWorkspaceTools } from '../src/tools/workspace.js';
import { registerTaskManager } from '../src/utils.js';
import { workspace, mockConfig } from './__mocks__/vscode.js';

// Workspace tools, prompt injection and the redirect guard must all be gated by
// the same condition: multi-root workspace AND bob-powertoys.tools.workspace.enabled.

const WORKSPACE_KEY = 'bob-powertoys.tools.workspace.enabled';
const VIDEO_KEY = 'bob-powertoys.tools.video.enabled';

const primary = nodePath.resolve('/ws/primary');
const secondary = nodePath.resolve('/ws/secondary');
const folder = (name: string, fsPath: string) => ({ name, uri: { fsPath } });

function setFolders(count: 0 | 1 | 2) {
  workspace.workspaceFolders = [folder('primary', primary), folder('secondary', secondary)].slice(0, count);
}

/** Captures what registerWorkspaceTools() registers on a Bob source. */
function fakeSource() {
  const tools: any[] = [];
  let onTurnStart: (taskId: string, envs: any, isEmpty: boolean) => void = () => {};
  let onToolWillExecute: (env: any, toolId: string, args: any) => any = () => undefined;
  return {
    tools,
    turnStart: (...a: [string, any, boolean]) => onTurnStart(...a),
    toolWillExecute: (...a: [any, string, any]) => onToolWillExecute(...a),
    registerTool: (t: any) => tools.push(t),
    onTurnStart: (cb: typeof onTurnStart) => { onTurnStart = cb; },
    onToolWillExecute: (cb: typeof onToolWillExecute) => { onToolWillExecute = cb; },
  };
}

/** Makes getTaskManager()/findTaskChatManager() resolve a task whose system message we can inspect. */
async function installFakeTask(taskId: string) {
  const systemMessage = { role: 'system', content: 'base prompt' };
  const task = { getMessages: () => [systemMessage] };
  const chatManager = { currentTask: task };
  await registerTaskManager({
    taskManager: { getChatManagerByTaskId: (id: string) => (id === taskId ? chatManager : undefined) },
  });
  return systemMessage;
}

const redirectingCall = ['read_file', { path: nodePath.join(secondary, 'a.txt') }] as const;

beforeEach(() => {
  delete mockConfig[WORKSPACE_KEY];
  delete mockConfig[VIDEO_KEY];
  setFolders(2);
});

afterEach(() => {
  vi.useRealTimers();
  workspace.workspaceFolders = [];
});

describe('workspace tools enabled()', () => {
  it('are all enabled in a multi-root workspace with the area on', () => {
    const src = fakeSource();
    registerWorkspaceTools(src);
    expect(src.tools).toHaveLength(13);
    expect(src.tools.every(t => t.enabled())).toBe(true);
  });

  it('are all disabled when the Workspace area is off', () => {
    const src = fakeSource();
    registerWorkspaceTools(src);
    mockConfig[WORKSPACE_KEY] = false;
    expect(src.tools.some(t => t.enabled())).toBe(false);
  });

  it.each([0, 1] as const)('are all disabled with %i workspace folder(s)', count => {
    const src = fakeSource();
    registerWorkspaceTools(src);
    setFolders(count);
    expect(src.tools.some(t => t.enabled())).toBe(false);
  });

  it('read_workspace_video_file additionally requires the Video area', () => {
    const src = fakeSource();
    registerWorkspaceTools(src);
    const video = src.tools.find(t => t.getId() === 'read_workspace_video_file');
    expect(video.enabled()).toBe(true);
    mockConfig[VIDEO_KEY] = false;
    expect(video.enabled()).toBe(false);
    // the other workspace tools are unaffected by the Video area
    expect(src.tools.filter(t => t !== video).every(t => t.enabled())).toBe(true);
  });
});

describe('built-in tool redirect guard (onToolWillExecute)', () => {
  it('cancels a built-in call targeting a secondary folder', () => {
    const src = fakeSource();
    registerWorkspaceTools(src);
    expect(src.toolWillExecute({}, ...redirectingCall)?.cancel).toBe(true);
  });

  it('does nothing when the Workspace area is off (replacement tools are hidden)', () => {
    const src = fakeSource();
    registerWorkspaceTools(src);
    mockConfig[WORKSPACE_KEY] = false;
    expect(src.toolWillExecute({}, ...redirectingCall)).toBeUndefined();
  });

  it('does nothing in a single-root workspace', () => {
    const src = fakeSource();
    registerWorkspaceTools(src);
    setFolders(1);
    expect(src.toolWillExecute({}, ...redirectingCall)).toBeUndefined();
  });

  it('re-evaluates at call time, so toggling the setting needs no re-registration', () => {
    const src = fakeSource();
    registerWorkspaceTools(src);
    mockConfig[WORKSPACE_KEY] = false;
    expect(src.toolWillExecute({}, ...redirectingCall)).toBeUndefined();
    delete mockConfig[WORKSPACE_KEY];
    expect(src.toolWillExecute({}, ...redirectingCall)?.cancel).toBe(true);
  });
});

describe('prompt injection (onTurnStart)', () => {
  async function run(isEmpty = true) {
    vi.useFakeTimers();
    const systemMessage = await installFakeTask('task-1');
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

  it('does not inject on resumed turns', async () => {
    expect(await run(false)).toBe('base prompt');
  });

  it('does not inject when the Workspace area is off', async () => {
    mockConfig[WORKSPACE_KEY] = false;
    expect(await run()).toBe('base prompt');
  });

  it('does not inject in a single-root workspace', async () => {
    setFolders(1);
    expect(await run()).toBe('base prompt');
  });
});
