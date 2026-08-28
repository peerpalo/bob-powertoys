import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { paramsToSchema } from '../utils.js';

const execFileAsync = promisify(execFile);

// TODO: ffmpeg path is hardcoded to 'ffmpeg' (relies on PATH).
// Upgrade path: add a 'ffmpegPath' config setting read from vscode.workspace.getConfiguration.
const FFMPEG = 'ffmpeg';

export const DEFAULT_VIDEO_FRAMES = 8;

/**
 * Extract frames from a video file using ffmpeg.
 * Primary-workspace tool — uses usage:'filePath' so Bob enforces its own
 * sandbox policy (including the "Allow outside workspace" setting).
 * For secondary workspace folders in multi-root setups use read_video_file_workspace.
 */
export class ReadVideoFileTool {
  static id = 'read_video_file';

  groups = ['read'];
  permission = 'read';

  getId(): string { return ReadVideoFileTool.id; }

  getDescription(_env?: any): string {
    return (
      'Extract frames from a video file using ffmpeg and save them as JPEG images ' +
      'into a temporary directory. Returns the absolute paths of the extracted frames. ' +
      'After calling this tool, read each frame path with the read_file tool and ' +
      'analyze the images directly to answer the user\'s question.\n\n' +
      'Use this when the user asks to inspect, debug, or analyze a video — ' +
      'e.g. "can you check why this happens" with a video path.\n\n' +
      'Parameter guidance:\n' +
      '- Specific time ("at 10 seconds"): seek="10", vf_filter="fps=2"\n' +
      '- Time range ("between 5 and 20 seconds"): seek="5", vf_filter="select=\'between(t,0,15)\',setpts=N/FRAME_RATE/TB,fps=3"\n' +
      '- Visual condition ("when the screen turns blue"): vf_filter="fps=1" (dense sampling, scan frames)\n' +
      '- No temporal context: omit vf_filter — tool extracts ' + DEFAULT_VIDEO_FRAMES + ' evenly-spaced frames.\n\n' +
      'For files in secondary workspace folders use read_video_file_workspace instead.\n' +
      'Requires ffmpeg to be installed and available on PATH.'
    );
  }

  getCostEffectiveDescription(): string {
    return 'Extract frames from a video file using ffmpeg for visual analysis';
  }

  static readonly PARAMS = [
    {
      name: 'video_path',
      required: true,
      type: 'string',
      description: 'Path to the video file, relative to the workspace root.',
      detail: 'Video file path',
      usage: 'filePath', // Bob enforces workspace sandbox via this sentinel
      renderHint: 'text',
    },
    {
      name: 'vf_filter',
      required: false,
      type: 'string',
      description:
        'Raw ffmpeg -vf filter expression. Build this when the user provides temporal or visual context. ' +
        'Examples: "fps=2" (2 frames/sec), "select=\'between(t,5,15)\',setpts=N/FRAME_RATE/TB,fps=3" (5–15 s range), ' +
        '"fps=1" (dense sampling). Omit to use the automatic evenly-spaced fallback.',
      detail: 'ffmpeg -vf filter (e.g. "fps=2")',
      usage: "select='between(t,5,15)',setpts=N/FRAME_RATE/TB,fps=3",
      renderHint: 'code',
    },
    {
      name: 'seek',
      required: false,
      type: 'string',
      description:
        'Start time for extraction in seconds or HH:MM:SS format (ffmpeg -ss). ' +
        'Use with vf_filter when the user names a specific timestamp or time range.',
      detail: 'Start time for seek (e.g. "10" or "00:00:10")',
      usage: '10',
    },
    {
      name: 'frames_count',
      required: false,
      type: 'number',
      description:
        'Max frames to extract. Only used when vf_filter is omitted (fallback mode). Defaults to ' + DEFAULT_VIDEO_FRAMES + '.',
      detail: `Max frames for fallback mode (default: ${DEFAULT_VIDEO_FRAMES})`,
      usage: '8',
    },
  ] as const;

  parameters = paramsToSchema(ReadVideoFileTool.PARAMS);

  getParameters(_env?: any): any[] {
    return ReadVideoFileTool.PARAMS as any;
  }

  getLabels(args: Record<string, any>) {
    const file = path.basename(args?.video_path ?? 'video');
    const hint = args?.vf_filter
      ? `filter: ${args.vf_filter}`
      : `${args?.frames_count ?? DEFAULT_VIDEO_FRAMES} frames`;
    return {
      displayName: `Read video: ${file}`,
      running: `Extracting frames from ${file} (${hint})...`,
      success: `Extracted frames from ${file}`,
      error: `Failed to extract frames from ${file}`,
    };
  }

  async call(context: {
    env: any;
    parameters: { video_path: string; vf_filter?: string; seek?: string; frames_count?: number };
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
  }): Promise<void> {
    const { video_path, vf_filter, seek, frames_count = DEFAULT_VIDEO_FRAMES } = context.parameters;

    if (!video_path?.trim()) {
      context.pushError('video_path is required');
      return;
    }

    const workspace: string = context.env?.workspace ?? process.cwd();
    const resolvedPath = path.isAbsolute(video_path)
      ? video_path
      : path.resolve(workspace, video_path);

    if (!fs.existsSync(resolvedPath)) {
      context.pushError(`Video file not found: ${resolvedPath}`);
      return;
    }

    // Output dir follows Bob's convention: <workspace>/.bob/tmp/<tool>/<timestamp>
    const outDir = path.join(workspace, '.bob', 'tmp', 'video-frames', `${Date.now()}`);
    fs.mkdirSync(outDir, { recursive: true });

    const outputPattern = path.join(outDir, 'frame_%04d.jpg');

    let ffmpegArgs: string[];

    if (vf_filter) {
      ffmpegArgs = [
        ...(seek ? ['-ss', seek] : []),
        '-i', resolvedPath,
        '-vf', vf_filter,
        '-q:v', '2',
        outputPattern,
      ];
    } else {
      // Probe duration to compute evenly-spaced fps.
      let duration = 0;
      try {
        const result = await execFileAsync(FFMPEG, ['-i', resolvedPath, '-f', 'null', '-'], { timeout: 30_000 })
          .catch((e: any) => ({ stderr: e.stderr ?? '' })) as { stderr: string };
        const m = result.stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        if (m) { duration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]); }
      } catch { /* leave duration = 0 */ }

      const fps = duration > 0
        ? (frames_count / duration).toFixed(6)
        : `1/${Math.max(1, Math.round(30 / frames_count))}`;

      ffmpegArgs = [
        '-i', resolvedPath,
        '-vf', `fps=${fps}`,
        '-frames:v', String(frames_count),
        '-q:v', '2',
        outputPattern,
      ];
    }

    try {
      await execFileAsync(FFMPEG, ffmpegArgs, { timeout: 120_000 });
    } catch (err) {
      context.pushError(
        `ffmpeg failed: ${err instanceof Error ? err.message : String(err)}\n` +
        'Make sure ffmpeg is installed and available on PATH.'
      );
      return;
    }

    const extracted = fs.readdirSync(outDir)
      .filter(f => f.endsWith('.jpg'))
      .sort()
      .map(f => path.join(outDir, f));

    if (extracted.length === 0) {
      context.pushError(`ffmpeg ran but no frames were written to ${outDir}`);
      return;
    }

    context.pushResult(JSON.stringify({
      frames_extracted: extracted.length,
      output_directory: outDir,
      frame_paths: extracted,
    }, null, 2));
  }
}

export function registerVideoTools(source: any) {
  source.registerTool(new ReadVideoFileTool());
}
