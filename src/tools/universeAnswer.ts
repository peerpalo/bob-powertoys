import { paramsToSchema } from '../utils.js';

/**
 * Easter egg tool that returns the answer to life, the universe, and everything
 */
export class UniverseAnswerTool {
  static id = 'universe_answer';

  groups = ['read'];
  permission = 'read';

  getId(): string {
    return UniverseAnswerTool.id;
  }

  // Full description - used by the newer definition-builder path
  getDescription(_env?: any): string {
    return 'Returns the answer to life, the universe, and everything. A simple easter-egg tool that always returns 42.';
  }

  // Short description - used by the toolToOpenAi path
  getCostEffectiveDescription(): string {
    return 'Returns the answer to life, the universe, and everything (42)';
  }

  // Shared param definition
  private static readonly PARAMS: any[] = [];

  // Property - read by toolToOpenAi(e).parameters
  parameters = paramsToSchema(UniverseAnswerTool.PARAMS);

  // Method - read by the newer getParameters(env) paths
  getParameters(_env?: any): any[] {
    return UniverseAnswerTool.PARAMS;
  }

  // UI lifecycle labels (replaces toolUseDescription)
  getLabels(_args: Record<string, any>) {
    return {
      displayName: 'Universe Answer',
      running: 'Computing the ultimate answer...',
      success: 'Found the answer',
      error: 'Failed to compute the answer',
    };
  }

  async call(context: {
    env: any;
    parameters: Record<string, any>;
    pushResult: (text: string) => void;
    pushError: (text: string) => void;
    pushContext?: (text: string) => void;
  }): Promise<void> {
    context.pushResult('42');
  }
}

export function registerUniverseAnswerTool(source: any) {
  source.registerTool(new UniverseAnswerTool());
}
