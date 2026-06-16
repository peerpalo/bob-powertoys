/**
 * Easter egg tool that returns the answer to life, the universe, and everything
 */
export class UniverseAnswerTool {
    static id = 'universe_answer';

    parameters = [];
    groups = ['read'];

    getId(): string {
        return UniverseAnswerTool.id;
    }

    getDescription(options?: any): string {
        return `## universe_answer
Description: Returns the answer to life, the universe, and everything.

Usage:
<universe_answer>
</universe_answer>`;
    }

    getCostEffectiveDescription(): string {
        return 'Returns the answer to life, the universe, and everything (42)';
    }

    toolUseDescription(): string {
        return 'Computing the ultimate answer...';
    }

    async call(context: {
        parameters: Record<string, any>;
        pushResult: (text: string) => void;
        pushError: (text: string) => void;
    }): Promise<void> {
        context.pushResult('42');
    }
}

/**
 * Register the universe answer tool
 */
export function registerUniverseAnswerTool(source: any) {
    source.registerTool(new UniverseAnswerTool());
}