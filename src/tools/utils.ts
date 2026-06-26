/**
 * Utility functions for Bob PowerToys tools
 */

import * as vscode from 'vscode';

/**
 * Resolve a frame ID for debug operations.
 * If the provided frameId is undefined, null, or <= 0, resolves to the top frame.
 *
 * @param frameId The frame ID from parameters (may be undefined, null, or invalid)
 * @param resolveTopFrame Async function to resolve the top frame ID
 * @returns The resolved frame ID
 */
export async function resolveFrameId(
  frameId: number | undefined | null,
  resolveTopFrame: () => Promise<number | undefined>
): Promise<number | undefined> {
  // If frameId is provided and valid (> 0), use it
  if (frameId !== undefined && frameId !== null && frameId > 0) {
    return frameId;
  }
  
  // Otherwise, resolve to top frame
  return await resolveTopFrame();
}
