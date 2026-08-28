import { describe, it, expect } from 'vitest';
import * as nodePath from 'path';
import { checkBuiltinToolRedirect } from '../src/tools/workspace.js';

// Platform-aware paths so the test suite works on both Windows and posix.
const isWin = process.platform === 'win32';
const PRIMARY   = isWin ? 'C:\\src\\specs-hub'              : '/src/specs-hub';
const SECONDARY = isWin ? 'C:\\src\\automation-planner'     : '/src/automation-planner';
const SECONDARY2 = isWin ? 'C:\\src\\bwl-ui'               : '/src/bwl-ui';

const FOLDERS = [
  { name: 'specs-hub',          uri: { fsPath: PRIMARY   } },
  { name: 'automation-planner', uri: { fsPath: SECONDARY } },
  { name: 'bwl-ui',             uri: { fsPath: SECONDARY2 } },
] as const;

const join = (...parts: string[]) => nodePath.join(...parts);

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Returns the redirect result; asserts it is defined and cancel === true. */
function expectRedirect(toolId: string, args: Record<string, any>) {
  const result = checkBuiltinToolRedirect(toolId, args, FOLDERS);
  expect(result, `expected redirect for ${toolId}`).toBeDefined();
  expect(result!.cancel).toBe(true);
  expect(result!.message).toContain(toolId);
  return result!;
}

/** Asserts the call passes through (no redirect). */
function expectPass(toolId: string, args: Record<string, any>) {
  const result = checkBuiltinToolRedirect(toolId, args, FOLDERS);
  expect(result, `expected no redirect for ${toolId}`).toBeUndefined();
}

// ─── unknown / non-sandboxed tools ───────────────────────────────────────────

describe('non-sandboxed tools', () => {
  it('ignores read_workspace_file (not a builtin)', () => {
    expectPass('read_workspace_file', { workspace: 'automation-planner', path: 'src/a.ts' });
  });

  it('ignores an arbitrary unknown tool', () => {
    expectPass('some_other_tool', { path: join(SECONDARY, 'src/a.ts') });
  });
});

// ─── single-root short-circuit ────────────────────────────────────────────────

describe('single-root workspace', () => {
  const single = [{ name: 'specs-hub', uri: { fsPath: PRIMARY } }] as const;

  it('passes through read_file when only one folder exists', () => {
    const result = checkBuiltinToolRedirect(
      'read_file', { path: join(SECONDARY, 'src/a.ts') }, single,
    );
    expect(result).toBeUndefined();
  });
});

// ─── primary folder paths pass through ───────────────────────────────────────

describe('primary folder paths', () => {
  it('passes through read_file with absolute path inside primary', () => {
    expectPass('read_file', { path: join(PRIMARY, 'src/a.ts') });
  });

  it('passes through read_file with relative path (resolves into primary)', () => {
    expectPass('read_file', { path: 'src/a.ts' });
  });

  it('passes through write_file with path inside primary', () => {
    expectPass('write_file', { path: join(PRIMARY, 'out/bundle.js') });
  });

  it('passes through execute_command when cwd is inside primary', () => {
    expectPass('execute_command', { command: 'npm test', cwd: join(PRIMARY, 'src') });
  });

  it('passes through execute_command when cwd is absent', () => {
    expectPass('execute_command', { command: 'npm test' });
  });
});

// ─── secondary folder paths are blocked ──────────────────────────────────────

describe('secondary folder paths — absolute', () => {
  it('blocks read_file pointing into first secondary folder', () => {
    const r = expectRedirect('read_file', { path: join(SECONDARY, 'src/tool.py') });
    expect(r.message).toContain('read_workspace_file');
    expect(r.message).toContain('automation-planner');
  });

  it('blocks read_file pointing into second secondary folder', () => {
    const r = expectRedirect('read_file', { path: join(SECONDARY2, 'src/App.tsx') });
    expect(r.message).toContain('read_workspace_file');
    expect(r.message).toContain('bwl-ui');
  });

  it('blocks write_file pointing into secondary', () => {
    const r = expectRedirect('write_file', { path: join(SECONDARY, 'out/result.json') });
    expect(r.message).toContain('write_workspace_file');
  });

  it('blocks list_files pointing into secondary', () => {
    const r = expectRedirect('list_files', { path: join(SECONDARY, 'src') });
    expect(r.message).toContain('list_workspace_files');
  });

  it('blocks glob pointing into secondary', () => {
    const r = expectRedirect('glob', { path: join(SECONDARY, 'src') });
    expect(r.message).toContain('glob_workspace');
  });

  it('blocks grep pointing into secondary', () => {
    const r = expectRedirect('grep', { path: join(SECONDARY, 'src') });
    expect(r.message).toContain('grep_workspace');
  });

  it('blocks insert_content pointing into secondary', () => {
    const r = expectRedirect('insert_content', { path: join(SECONDARY, 'config.yaml') });
    expect(r.message).toContain('insert_workspace_content');
  });

  it('blocks search_and_replace pointing into secondary', () => {
    const r = expectRedirect('search_and_replace', { path: join(SECONDARY, 'README.md') });
    expect(r.message).toContain('search_and_replace_workspace');
  });

  it('blocks apply_diff pointing into secondary', () => {
    const r = expectRedirect('apply_diff', { path: join(SECONDARY, 'src/main.py') });
    expect(r.message).toContain('apply_diff_workspace');
  });

  it('blocks execute_command when cwd is inside secondary', () => {
    const r = expectRedirect('execute_command', { command: 'pytest', cwd: join(SECONDARY, 'tests') });
    expect(r.message).toContain('execute_workspace_command');
    expect(r.message).toContain('automation-planner');
  });

  it('blocks read_video_file pointing into secondary', () => {
    const r = expectRedirect('read_video_file', { video_path: join(SECONDARY, 'recordings/demo.mp4') });
    expect(r.message).toContain('read_workspace_video_file');
    expect(r.message).toContain('automation-planner');
  });
});

// ─── exact secondary folder root is also blocked ─────────────────────────────

describe('secondary folder root itself', () => {
  it('blocks read_file with path exactly equal to secondary root', () => {
    expectRedirect('read_file', { path: SECONDARY });
  });

  it('blocks list_files with path exactly equal to secondary root', () => {
    expectRedirect('list_files', { path: SECONDARY });
  });
});

// ─── prefix collision guard ───────────────────────────────────────────────────

describe('prefix collision', () => {
  // "/src/automation-planner-extra" must NOT match "/src/automation-planner"
  const extraSecondary = isWin
    ? 'C:\\src\\automation-planner-extra'
    : '/src/automation-planner-extra';

  it('does not match a path that merely starts with the secondary fsPath string', () => {
    expectPass('read_file', { path: join(extraSecondary, 'src/a.ts') });
  });
});

// ─── message content ─────────────────────────────────────────────────────────

describe('message content', () => {
  it('names the blocked tool', () => {
    const r = expectRedirect('read_file', { path: join(SECONDARY, 'src/a.ts') });
    expect(r.message).toContain('`read_file`');
  });

  it('names the replacement tool', () => {
    const r = expectRedirect('read_file', { path: join(SECONDARY, 'src/a.ts') });
    expect(r.message).toContain('`read_workspace_file`');
  });

  it('names the secondary folder', () => {
    const r = expectRedirect('read_file', { path: join(SECONDARY, 'src/a.ts') });
    expect(r.message).toContain('automation-planner');
  });

  it('names the primary folder', () => {
    const r = expectRedirect('read_file', { path: join(SECONDARY, 'src/a.ts') });
    expect(r.message).toContain('specs-hub');
  });

  it('includes the original raw path', () => {
    const rawPath = join(SECONDARY, 'src/a.ts');
    const r = expectRedirect('read_file', { path: rawPath });
    expect(r.message).toContain(rawPath);
  });

  it('tells the user to pass workspace= parameter', () => {
    const r = expectRedirect('read_file', { path: join(SECONDARY, 'src/a.ts') });
    expect(r.message).toContain('workspace="automation-planner"');
  });
});
