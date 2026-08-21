import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { absolutiseToolContent, resolveOpenFilePath } from '../src/utils.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

import * as fs from 'fs';

// Platform-aware separator so expected values work on both Windows and posix.
const s = path.sep;
const ROOT = process.platform === 'win32' ? 'C:\\src\\backend' : '/src/backend';
const join = (...parts: string[]) => path.join(...parts);

// ─── absolutiseToolContent ────────────────────────────────────────────────────

describe('absolutiseToolContent', () => {

  // ── glob ────────────────────────────────────────────────────────────────────
  describe('glob mode', () => {

    it('absolutises a single relative path', () => {
      const result = absolutiseToolContent('src/utils/foo.ts', 'glob', ROOT);
      expect(result).toBe(join(ROOT, 'src/utils/foo.ts'));
    });

    it('absolutises multiple relative paths', () => {
      const input = ['src/a.ts', 'lib/b.ts'].join('\n');
      const result = absolutiseToolContent(input, 'glob', ROOT);
      expect(result).toBe([join(ROOT, 'src/a.ts'), join(ROOT, 'lib/b.ts')].join('\n'));
    });

    it('leaves already-absolute paths unchanged', () => {
      const abs = join(ROOT, 'src/a.ts');
      expect(absolutiseToolContent(abs, 'glob', ROOT)).toBe(abs);
    });

    it('preserves blank lines', () => {
      const input = 'src/a.ts\n\nlib/b.ts';
      const result = absolutiseToolContent(input, 'glob', ROOT);
      expect(result).toBe([join(ROOT, 'src/a.ts'), '', join(ROOT, 'lib/b.ts')].join('\n'));
    });

    it('handles a bare root-level filename with no separator', () => {
      expect(absolutiseToolContent('tsconfig.json', 'glob', ROOT))
        .toBe(join(ROOT, 'tsconfig.json'));
    });

    it('handles a bare dotfile at root', () => {
      expect(absolutiseToolContent('.env', 'glob', ROOT))
        .toBe(join(ROOT, '.env'));
    });

    it('returns "No files found" unchanged', () => {
      expect(absolutiseToolContent('No files found', 'glob', ROOT)).toBe('No files found');
    });

    it('handles a filename with spaces at root', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      expect(absolutiseToolContent('My File.ts', 'glob', ROOT))
        .toBe(join(ROOT, 'My File.ts'));
    });

    it('returns content unchanged when workspaceRoot is empty', () => {
      expect(absolutiseToolContent('src/a.ts', 'glob', '')).toBe('src/a.ts');
    });

    it('returns content unchanged when content is empty', () => {
      expect(absolutiseToolContent('', 'glob', ROOT)).toBe('');
    });

    it('handles list_files directory listing header (prose line with spaces)', () => {
      // list_files emits "Directory listing for <absPath>:\n\n<entries>"
      // The header contains spaces and is not a plain path — it gets joined with root
      // (producing a non-existent path string), but parseFileListContent strips line 0
      // via LIST_FILES_HEADER_RE so the mangled header is never shown to the user.
      // Entries below the blank line are correctly absolutised.
      const header = `Directory listing for ${ROOT}:`;
      const mangledHeader = join(ROOT, header); // expected: root joined with the prose line
      const input = [header, '', 'src/', 'lib/'].join('\n');
      const result = absolutiseToolContent(input, 'glob', ROOT);
      expect(result).toBe([mangledHeader, '', join(ROOT, 'src/'), join(ROOT, 'lib/')].join('\n'));
    });

    it('handles truncation notice line', () => {
      // Truncation line starts with "(" — treated as a relative path and joined,
      // which is acceptable since parseFileListContent ignores it anyway.
      // Main thing: no crash.
      expect(() => absolutiseToolContent('(Results truncated: showing 200 of 300)', 'glob', ROOT))
        .not.toThrow();
    });
  });

  // ── grep ────────────────────────────────────────────────────────────────────
  describe('grep mode', () => {

    it('absolutises file-header lines', () => {
      const input = [
        'Found 2 matches',
        'src/utils/foo.ts:',
        '  Line 10: const x = 1',
        'lib/bar.ts:',
        '  Line 5: return y',
      ].join('\n');
      const result = absolutiseToolContent(input, 'grep', ROOT);
      expect(result).toBe([
        'Found 2 matches',
        join(ROOT, 'src/utils/foo.ts') + ':',
        '  Line 10: const x = 1',
        join(ROOT, 'lib/bar.ts') + ':',
        '  Line 5: return y',
      ].join('\n'));
    });

    it('leaves match lines (with leading spaces) untouched', () => {
      const matchLine = '  Line 42: some code here';
      expect(absolutiseToolContent(
        `src/a.ts:\n${matchLine}`, 'grep', ROOT,
      )).toBe(`${join(ROOT, 'src/a.ts')}:\n${matchLine}`);
    });

    it('leaves already-absolute file headers unchanged', () => {
      const abs = join(ROOT, 'src/a.ts');
      const input = `${abs}:\n  Line 1: foo`;
      expect(absolutiseToolContent(input, 'grep', ROOT)).toBe(input);
    });

    it('leaves header-only prose lines unchanged', () => {
      const line = 'Found 3 matches';
      expect(absolutiseToolContent(line, 'grep', ROOT)).toBe(line);
    });

    it('absolutises a file-header line with spaces at root', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      expect(absolutiseToolContent('My File.ts:', 'grep', ROOT))
        .toBe(join(ROOT, 'My File.ts') + ':');
    });

    it('leaves a prose line ending with colon unchanged', () => {
      // existsSync returns false (default mock wraps real impl, file doesn't exist)
      expect(absolutiseToolContent('Note: something happened:', 'grep', ROOT))
        .toBe('Note: something happened:');
    });

    it('returns content unchanged when workspaceRoot is empty', () => {
      expect(absolutiseToolContent('src/a.ts:', 'grep', '')).toBe('src/a.ts:');
    });
  });

});

// ─── resolveOpenFilePath ───────────────────────────────────────────────────────

const FOLDERS = [
  { name: 'pm-be-main',        uri: { fsPath: '/src/pm-be-main' } },
  { name: 'process-discovery', uri: { fsPath: '/src/process-discovery' } },
] as const;

describe('resolveOpenFilePath', () => {

  // ── ./ prefix stripping ────────────────────────────────────────────────────
  describe('./ prefix (webview ct() prepends this)', () => {
    it('resolves ./folder-name/sub/file.ts', () => {
      expect(resolveOpenFilePath('./process-discovery/src/api/foo.js', FOLDERS))
        .toBe(join('/src/process-discovery', 'src/api/foo.js'));
    });

    it('resolves ./folder-name with no sub-path', () => {
      expect(resolveOpenFilePath('./process-discovery', FOLDERS))
        .toBe('/src/process-discovery');
    });

    it('resolves ./folder-name/ trailing slash variant', () => {
      // stripped = "process-discovery/" → startsWith("process-discovery/") ✓
      expect(resolveOpenFilePath('./process-discovery/src', FOLDERS))
        .toBe(join('/src/process-discovery', 'src'));
    });
  });

  // ── no ./ prefix ───────────────────────────────────────────────────────────
  describe('no ./ prefix', () => {
    it('resolves folder-name/sub/file.ts', () => {
      expect(resolveOpenFilePath('process-discovery/src/api/foo.js', FOLDERS))
        .toBe(join('/src/process-discovery', 'src/api/foo.js'));
    });

    it('resolves exact folder name with no sub-path', () => {
      expect(resolveOpenFilePath('process-discovery', FOLDERS))
        .toBe('/src/process-discovery');
    });
  });

  // ── already absolute ───────────────────────────────────────────────────────
  describe('absolute paths', () => {
    it('returns absolute path unchanged (posix)', () => {
      expect(resolveOpenFilePath('/src/process-discovery/foo.ts', FOLDERS))
        .toBe('/src/process-discovery/foo.ts');
    });
  });

  // ── no match ───────────────────────────────────────────────────────────────
  describe('no folder match', () => {
    it('returns the original path when no folder name matches', () => {
      expect(resolveOpenFilePath('./unknown-folder/src/foo.ts', FOLDERS))
        .toBe('./unknown-folder/src/foo.ts');
    });

    it('returns empty string unchanged', () => {
      expect(resolveOpenFilePath('', FOLDERS)).toBe('');
    });
  });

  // ── backslash variant ──────────────────────────────────────────────────────
  describe('backslash separator (Windows)', () => {
    it('resolves folder-name\\sub\\file.ts', () => {
      expect(resolveOpenFilePath('process-discovery\\src\\api\\foo.js', FOLDERS))
        .toBe(join('/src/process-discovery', 'src', 'api', 'foo.js'));
    });
  });

  // ── primary folder is also matched ────────────────────────────────────────
  describe('primary folder', () => {
    it('resolves a path under the primary folder too', () => {
      expect(resolveOpenFilePath('./pm-be-main/src/index.ts', FOLDERS))
        .toBe(join('/src/pm-be-main', 'src/index.ts'));
    });
  });

  // ── prefix collision guard ─────────────────────────────────────────────────
  describe('prefix collision', () => {
    it('does not match "process" against "process-discovery" folder', () => {
      expect(resolveOpenFilePath('./process/foo.ts', FOLDERS))
        .toBe('./process/foo.ts');
    });
  });

});
