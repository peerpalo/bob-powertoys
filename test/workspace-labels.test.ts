import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import {
  labelPath,
  ReadWorkspaceFileTool,
  WriteWorkspaceFileTool,
  ListWorkspaceFilesTool,
  GlobWorkspaceTool,
  GrepWorkspaceTool,
  InsertWorkspaceContentTool,
  SearchAndReplaceWorkspaceTool,
  ApplyDiffWorkspaceTool,
  ExecuteWorkspaceCommandTool,
  ReadVideoFileWorkspaceTool,
} from '../src/tools/workspace.js';
import { workspace, Uri } from './__mocks__/vscode.js';

// Bob's own labels show the full path. Our workspace tools take the folder *name*
// (`workspace`) plus a path relative to it, so labels must resolve the name to the
// folder's real fsPath and append the path.

const backendRoot = path.resolve('/ws/backend');
const expected = path.join(backendRoot, 'src', 'app.ts');

const originalJoinPath = Uri.joinPath;
beforeEach(() => {
  workspace.workspaceFolders = [
    { name: 'frontend', index: 0, uri: { fsPath: path.resolve('/ws/frontend') } },
    { name: 'backend', index: 1, uri: { fsPath: backendRoot } },
  ];
  // The shared mock returns an empty fsPath; make it behave like the real one.
  Uri.joinPath = (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) });
});
afterEach(() => {
  workspace.workspaceFolders = [];
  Uri.joinPath = originalJoinPath;
});

describe('labelPath', () => {
  it('resolves the folder name to its real path and appends the relative path', () => {
    expect(labelPath('backend', 'src/app.ts')).toBe(expected);
  });
  it('returns the folder root when path is omitted or "."', () => {
    expect(labelPath('backend')).toBe(backendRoot);
    expect(labelPath('backend', '.')).toBe(backendRoot);
  });
  it('falls back to the raw arguments for an unknown folder', () => {
    expect(labelPath('nope', 'a.ts')).toBe(path.join('nope', 'a.ts'));
  });
  it('does not throw for the {} Bob passes while a call is streaming', () => {
    expect(() => labelPath()).not.toThrow();
    expect(labelPath()).not.toContain('undefined');
  });
});

describe('workspace tool labels show the full path', () => {
  const args = { workspace: 'backend', path: 'src/app.ts' };
  const cases: Array<[string, any, Record<string, any>]> = [
    ['read_workspace_file', new ReadWorkspaceFileTool(), args],
    ['write_workspace_file', new WriteWorkspaceFileTool(), args],
    ['list_workspace_files', new ListWorkspaceFilesTool(), args],
    ['glob_workspace', new GlobWorkspaceTool(), args],
    ['grep_workspace', new GrepWorkspaceTool(), args],
    ['insert_workspace_content', new InsertWorkspaceContentTool(), args],
    ['search_and_replace_workspace', new SearchAndReplaceWorkspaceTool(), args],
    ['apply_diff_workspace', new ApplyDiffWorkspaceTool(), args],
    ['execute_workspace_command', new ExecuteWorkspaceCommandTool(), { workspace: 'backend', cwd: 'src/app.ts' }],
    ['read_workspace_video_file', new ReadVideoFileWorkspaceTool(), { workspace: 'backend', video_path: 'src/app.ts' }],
  ];

  it.each(cases)('%s', (_id, tool, a) => {
    const labels = tool.getLabels(a);
    for (const text of [labels.displayName, labels.running, labels.success, labels.error]) {
      expect(text).toContain(expected);
    }
  });

  it.each(cases)('%s tolerates getLabels({})', (_id, tool) => {
    const labels = tool.getLabels({});
    for (const text of [labels.displayName, labels.running, labels.success, labels.error]) {
      expect(text).not.toContain('undefined');
    }
  });
});
