import { describe, it, expect } from 'vitest';
import { ReadVideoFileTool } from '../src/tools/videos.js';

// Bob's own tools show the path exactly as the model passed it (Read File {path}),
// not just the file name. Our video tool must do the same.
// (read_workspace_video_file is covered in workspace-labels.test.ts.)
describe('read_video_file label shows the full path', () => {
  it('keeps directories, not just the file name', () => {
    const video_path = 'recordings/2026/bug-repro.mp4';
    const labels = new ReadVideoFileTool().getLabels({ video_path });
    for (const text of [labels.displayName, labels.running, labels.success, labels.error]) {
      expect(text).toContain(video_path);
    }
  });
});
