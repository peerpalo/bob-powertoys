import { describe, it, expect, vi } from 'vitest';
import * as nodePath from 'path';
import * as os from 'os';
import {
  isInsideDir,
  resolveLikeBob,
  shouldStripFilePathUsage,
  rewriteSecondaryRelativePath,
} from '../src/tools/workspace.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

import * as fs from 'fs';
const existsMock = vi.mocked(fs.existsSync);

const primary = nodePath.resolve('/ws/primary');
const secondary = nodePath.resolve('/ws/secondary');
const folders = [
  { name: 'primary', uri: { fsPath: primary } },
  { name: 'secondary', uri: { fsPath: secondary } },
];
const env = { id: 't1', workspace: primary };

const PATH_PARAM = [{ name: 'path', type: 'string', required: true, usage: 'filePath' }];
const CWD_PARAM = [{ name: 'cwd', type: 'string', required: false, usage: 'filePath' }];
const NO_PATH_PARAM = [{ name: 'pattern', type: 'string', required: true }];

// ─── isInsideDir ──────────────────────────────────────────────────────────────

describe('isInsideDir', () => {
  it('matches the directory itself and paths inside it', () => {
    expect(isInsideDir(secondary, secondary)).toBe(true);
    expect(isInsideDir(nodePath.join(secondary, 'src', 'a.ts'), secondary)).toBe(true);
  });

  it('rejects paths outside and prefix collisions', () => {
    expect(isInsideDir(primary, secondary)).toBe(false);
    expect(isInsideDir(nodePath.resolve('/ws/secondary-v2'), secondary)).toBe(false);
  });
});

// ─── resolveLikeBob ───────────────────────────────────────────────────────────

describe('resolveLikeBob', () => {
  it('resolves relative paths against the workspace root', () => {
    expect(resolveLikeBob(primary, 'src/a.ts')).toBe(nodePath.join(primary, 'src', 'a.ts'));
  });

  it('keeps absolute paths', () => {
    expect(resolveLikeBob(primary, secondary)).toBe(secondary);
  });

  it('expands ~ to the home directory', () => {
    expect(resolveLikeBob(primary, '~/x')).toBe(nodePath.resolve(os.homedir(), 'x'));
  });
});

// ─── shouldStripFilePathUsage ─────────────────────────────────────────────────

describe('shouldStripFilePathUsage', () => {
  it('strips when every filePath value is inside a workspace folder', () => {
    expect(shouldStripFilePathUsage(PATH_PARAM, { path: nodePath.join(secondary, 'a.txt') }, env, folders)).toBe(true);
    expect(shouldStripFilePathUsage(PATH_PARAM, { path: nodePath.join(primary, 'a.txt') }, env, folders)).toBe(true);
  });

  it('strips for execute_command cwd inside a workspace folder', () => {
    expect(shouldStripFilePathUsage(CWD_PARAM, { cwd: secondary }, env, folders)).toBe(true);
  });

  it('keeps the tag when a path is outside every folder (native flags apply)', () => {
    expect(shouldStripFilePathUsage(PATH_PARAM, { path: nodePath.resolve('/elsewhere/a.txt') }, env, folders)).toBe(false);
  });

  it('keeps the tag when any one of several paths is outside', () => {
    const params = [...PATH_PARAM, { name: 'other', type: 'string', usage: 'filePath' }];
    const args = { path: nodePath.join(secondary, 'a.txt'), other: nodePath.resolve('/elsewhere') };
    expect(shouldStripFilePathUsage(params, args, env, folders)).toBe(false);
  });

  it('keeps the tag for paths inside ~/.bob (Bob home-write protection)', () => {
    const bobHome = nodePath.join(os.homedir(), '.bob');
    expect(shouldStripFilePathUsage(PATH_PARAM, { path: nodePath.join(bobHome, 'settings', 'x.json') }, env, folders)).toBe(false);
  });

  it('ignores absent or empty values like Bob does', () => {
    expect(shouldStripFilePathUsage(CWD_PARAM, {}, env, folders)).toBe(false);
    expect(shouldStripFilePathUsage(CWD_PARAM, { cwd: '  ' }, env, folders)).toBe(false);
  });

  it('returns false when the tool has no filePath params (nothing to strip)', () => {
    expect(shouldStripFilePathUsage(NO_PATH_PARAM, { pattern: 'x' }, env, folders)).toBe(false);
  });

  it('resolves relative values against the primary root before deciding', () => {
    // "../secondary/a.txt" escapes the primary root into the secondary folder
    expect(shouldStripFilePathUsage(PATH_PARAM, { path: '../secondary/a.txt' }, env, folders)).toBe(true);
    // "../../elsewhere" escapes every folder
    expect(shouldStripFilePathUsage(PATH_PARAM, { path: '../../elsewhere/a.txt' }, env, folders)).toBe(false);
  });
});

// ─── rewriteSecondaryRelativePath ─────────────────────────────────────────────

describe('rewriteSecondaryRelativePath', () => {
  it('rewrites folder-name-prefixed paths that exist only in the secondary folder', () => {
    existsMock.mockImplementation((p: any) => nodePath.resolve(String(p)) === nodePath.join(secondary, 'src', 'a.ts'));
    expect(rewriteSecondaryRelativePath('secondary/src/a.ts', primary, folders.slice(1)))
      .toBe(nodePath.join(secondary, 'src', 'a.ts'));
  });

  it('leaves paths that resolve under the workspace root', () => {
    existsMock.mockImplementation((p: any) => nodePath.resolve(String(p)) === nodePath.join(primary, 'secondary', 'x'));
    expect(rewriteSecondaryRelativePath('secondary/x', primary, folders.slice(1))).toBe('secondary/x');
  });

  it('leaves paths that do not exist anywhere', () => {
    existsMock.mockReturnValue(false);
    expect(rewriteSecondaryRelativePath('secondary/missing.ts', primary, folders.slice(1))).toBe('secondary/missing.ts');
  });

  it('leaves absolute paths, ../ escapes and unknown folder names untouched', () => {
    existsMock.mockReturnValue(false);
    expect(rewriteSecondaryRelativePath(nodePath.join(secondary, 'a.ts'), primary, folders.slice(1)))
      .toBe(nodePath.join(secondary, 'a.ts'));
    expect(rewriteSecondaryRelativePath('../secondary/a.ts', primary, folders.slice(1))).toBe('../secondary/a.ts');
    expect(rewriteSecondaryRelativePath('unknown/a.ts', primary, folders.slice(1))).toBe('unknown/a.ts');
  });

  it('matches only the secondary folders passed in', () => {
    existsMock.mockReturnValue(true);
    // primary is not in the eligible list → no rewrite even though the name matches
    expect(rewriteSecondaryRelativePath('primary/src/a.ts', primary, folders.slice(1))).toBe('primary/src/a.ts');
  });
});
