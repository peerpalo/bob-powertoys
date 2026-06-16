/**
 * Utility functions for Bob PowerToys tools
 */

import * as vscode from 'vscode';

/**
 * Parse a parameter that might be a JSON string or already parsed object/array.
 * Bob's native API sends complex parameters as JSON strings.
 *
 * @param param The parameter value (string or already parsed)
 * @param paramName Name of the parameter for error messages
 * @returns The parsed value
 * @throws Error if parsing fails
 */
export function parseJsonParameter<T>(param: string | T, paramName: string): T {
  if (typeof param === 'string') {
    try {
      return JSON.parse(param) as T;
    } catch (error) {
      throw new Error(
        `Failed to parse ${paramName} parameter: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return param;
}

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
