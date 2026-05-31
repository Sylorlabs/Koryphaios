/**
 * Prompt registry for managing MCP prompts
 */

import type { MCPPrompt } from '@/types/index.js';

export interface PromptResult {
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: {
      type: 'text';
      text: string;
    };
  }>;
}

export type PromptHandler = (args?: Record<string, unknown>) => Promise<PromptResult>;

export class PromptRegistry {
  private prompts: Map<string, MCPPrompt> = new Map();
  private handlers: Map<string, PromptHandler> = new Map();

  constructor() {
    this.registerCorePrompts();
  }

  registerPrompt(prompt: MCPPrompt, handler?: PromptHandler): void {
    if (this.prompts.has(prompt.name)) {
      throw new Error(`Prompt ${prompt.name} is already registered`);
    }

    this.prompts.set(prompt.name, prompt);

    if (handler) {
      this.handlers.set(prompt.name, handler);
    } else {
      // Register default handler based on prompt name
      this.handlers.set(prompt.name, this.createDefaultHandler(prompt.name));
    }
  }

  unregisterPrompt(name: string): void {
    this.prompts.delete(name);
    this.handlers.delete(name);
  }

  listPrompts(): MCPPrompt[] {
    return Array.from(this.prompts.values());
  }

  getPrompt(name: string): MCPPrompt | undefined {
    return this.prompts.get(name);
  }

  async executePrompt(name: string, args?: Record<string, unknown>): Promise<PromptResult> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`No handler registered for prompt: ${name}`);
    }

    return await handler(args);
  }

  private registerCorePrompts(): void {
    // Error explanation prompt
    this.registerPrompt({
      name: 'explain-error',
      description: 'Generate a detailed explanation of an error',
      arguments: [
        {
          name: 'errorMessage',
          description: 'The error message to explain',
          required: true,
        },
        {
          name: 'stackTrace',
          description: 'Stack trace information',
          required: false,
        },
        {
          name: 'codeContext',
          description: 'Surrounding code context',
          required: false,
        },
        {
          name: 'language',
          description: 'Programming language',
          required: false,
        },
      ],
    });

    // Fix suggestion prompt
    this.registerPrompt({
      name: 'suggest-fix',
      description: 'Generate fix suggestions for an error',
      arguments: [
        {
          name: 'errorMessage',
          description: 'The error message',
          required: true,
        },
        {
          name: 'codeSnippet',
          description: 'Code snippet where error occurred',
          required: true,
        },
        {
          name: 'language',
          description: 'Programming language',
          required: false,
        },
        {
          name: 'framework',
          description: 'Framework being used',
          required: false,
        },
      ],
    });

    // Performance analysis prompt
    this.registerPrompt({
      name: 'analyze-performance',
      description: 'Analyze performance issues and suggest optimizations',
      arguments: [
        {
          name: 'profileData',
          description: 'Performance profiling data',
          required: true,
        },
        {
          name: 'codeContext',
          description: 'Code context for analysis',
          required: false,
        },
        {
          name: 'language',
          description: 'Programming language',
          required: false,
        },
      ],
    });

    // Debug guidance prompt
    this.registerPrompt({
      name: 'debug-guidance',
      description: 'Provide debugging guidance and strategies',
      arguments: [
        {
          name: 'problemDescription',
          description: 'Description of the problem',
          required: true,
        },
        {
          name: 'language',
          description: 'Programming language',
          required: false,
        },
        {
          name: 'framework',
          description: 'Framework being used',
          required: false,
        },
        {
          name: 'environment',
          description: 'Development environment',
          required: false,
        },
      ],
    });

    // Code review prompt
    this.registerPrompt({
      name: 'code-review',
      description: 'Perform code review and identify potential issues',
      arguments: [
        {
          name: 'codeSnippet',
          description: 'Code to review',
          required: true,
        },
        {
          name: 'language',
          description: 'Programming language',
          required: false,
        },
        {
          name: 'focusAreas',
          description: 'Specific areas to focus on (security, performance, etc.)',
          required: false,
        },
      ],
    });

    // Error prevention prompt
    this.registerPrompt({
      name: 'error-prevention',
      description: 'Suggest ways to prevent similar errors in the future',
      arguments: [
        {
          name: 'errorHistory',
          description: 'Historical error data',
          required: true,
        },
        {
          name: 'codebase',
          description: 'Codebase information',
          required: false,
        },
        {
          name: 'language',
          description: 'Programming language',
          required: false,
        },
      ],
    });
  }

  private createDefaultHandler(promptName: string): PromptHandler {
    return async (args?: Record<string, unknown>): Promise<PromptResult> => {
      switch (promptName) {
        case 'explain-error':
          return this.handleExplainError(args);

        case 'suggest-fix':
          return this.handleSuggestFix(args);

        case 'analyze-performance':
          return this.handleAnalyzePerformance(args);

        case 'debug-guidance':
          return this.handleDebugGuidance(args);

        case 'code-review':
          return this.handleCodeReview(args);

        case 'error-prevention':
          return this.handleErrorPrevention(args);

        default:
          throw new Error(`No default handler available for prompt: ${promptName}`);
      }
    };
  }

  private async handleExplainError(args?: Record<string, unknown>): Promise<PromptResult> {
    const errorMessage = (args?.['errorMessage'] as string) || '';
    const stackTrace = (args?.['stackTrace'] as string) || '';
    const codeContext = (args?.['codeContext'] as string) || '';
    const language = (args?.['language'] as string) || 'javascript';

    const systemPrompt = `You are an expert debugging assistant. Explain the following error in detail, including:
1. What the error means
2. Common causes
3. How to identify the root cause
4. Prevention strategies

Be clear and educational in your explanation.`;

    const userPrompt = `Error: ${errorMessage}

${stackTrace ? `Stack Trace:\n${stackTrace}\n` : ''}
${codeContext ? `Code Context:\n${codeContext}\n` : ''}
Language: ${language}

Please explain this error in detail.`;

    return {
      messages: [
        {
          role: 'system',
          content: {
            type: 'text',
            text: systemPrompt,
          },
        },
        {
          role: 'user',
          content: {
            type: 'text',
            text: userPrompt,
          },
        },
      ],
    };
  }

  private async handleSuggestFix(args?: Record<string, unknown>): Promise<PromptResult> {
    const errorMessage = (args?.['errorMessage'] as string) || '';
    const codeSnippet = (args?.['codeSnippet'] as string) || '';
    const language = (args?.['language'] as string) || 'javascript';
    const framework = (args?.['framework'] as string) || '';

    const systemPrompt = `You are an expert developer. Analyze the error and code snippet, then provide specific fix suggestions including:
1. Immediate fixes to resolve the error
2. Code improvements to prevent similar issues
3. Best practices recommendations
4. Alternative approaches if applicable

Provide concrete code examples for your suggestions.`;

    const userPrompt = `Error: ${errorMessage}

Code Snippet:
\`\`\`${language}
${codeSnippet}
\`\`\`

${framework ? `Framework: ${framework}\n` : ''}

Please suggest specific fixes for this error.`;

    return {
      messages: [
        {
          role: 'system',
          content: {
            type: 'text',
            text: systemPrompt,
          },
        },
        {
          role: 'user',
          content: {
            type: 'text',
            text: userPrompt,
          },
        },
      ],
    };
  }

  private async handleAnalyzePerformance(args?: Record<string, unknown>): Promise<PromptResult> {
    const profileData = (args?.['profileData'] as string) || '';
    const codeContext = (args?.['codeContext'] as string) || '';
    const language = (args?.['language'] as string) || 'javascript';

    const systemPrompt = `You are a performance optimization expert. Analyze the profiling data and provide:
1. Performance bottlenecks identification
2. Optimization recommendations
3. Code improvements
4. Best practices for better performance

Focus on actionable insights and specific improvements.`;

    const userPrompt = `Performance Profile Data:
${profileData}

${codeContext ? `Code Context:\n${codeContext}\n` : ''}
Language: ${language}

Please analyze this performance data and suggest optimizations.`;

    return {
      messages: [
        {
          role: 'system',
          content: {
            type: 'text',
            text: systemPrompt,
          },
        },
        {
          role: 'user',
          content: {
            type: 'text',
            text: userPrompt,
          },
        },
      ],
    };
  }

  private async handleDebugGuidance(args?: Record<string, unknown>): Promise<PromptResult> {
    const problemDescription = (args?.['problemDescription'] as string) || '';
    const language = (args?.['language'] as string) || 'javascript';
    const framework = (args?.['framework'] as string) || '';
    const environment = (args?.['environment'] as string) || '';

    const systemPrompt = `You are a debugging expert. Provide systematic debugging guidance including:
1. Debugging strategy and approach
2. Tools and techniques to use
3. Step-by-step debugging process
4. Common pitfalls to avoid

Tailor your advice to the specific language and environment.`;

    const userPrompt = `Problem: ${problemDescription}

Language: ${language}
${framework ? `Framework: ${framework}\n` : ''}
${environment ? `Environment: ${environment}\n` : ''}

Please provide debugging guidance for this problem.`;

    return {
      messages: [
        {
          role: 'system',
          content: {
            type: 'text',
            text: systemPrompt,
          },
        },
        {
          role: 'user',
          content: {
            type: 'text',
            text: userPrompt,
          },
        },
      ],
    };
  }

  private async handleCodeReview(args?: Record<string, unknown>): Promise<PromptResult> {
    const codeSnippet = (args?.['codeSnippet'] as string) || '';
    const language = (args?.['language'] as string) || 'javascript';
    const focusAreas = (args?.['focusAreas'] as string) || 'general';

    const systemPrompt = `You are a senior code reviewer. Review the code and provide feedback on:
1. Code quality and best practices
2. Potential bugs and issues
3. Security considerations
4. Performance implications
5. Maintainability and readability

Be constructive and specific in your feedback.`;

    const userPrompt = `Code to Review:
\`\`\`${language}
${codeSnippet}
\`\`\`

Language: ${language}
Focus Areas: ${focusAreas}

Please review this code and provide detailed feedback.`;

    return {
      messages: [
        {
          role: 'system',
          content: {
            type: 'text',
            text: systemPrompt,
          },
        },
        {
          role: 'user',
          content: {
            type: 'text',
            text: userPrompt,
          },
        },
      ],
    };
  }

  private async handleErrorPrevention(args?: Record<string, unknown>): Promise<PromptResult> {
    const errorHistory = (args?.['errorHistory'] as string) || '';
    const codebase = (args?.['codebase'] as string) || '';
    const language = (args?.['language'] as string) || 'javascript';

    const systemPrompt = `You are a software quality expert. Analyze the error patterns and suggest prevention strategies including:
1. Code patterns and practices to adopt
2. Tools and processes to implement
3. Testing strategies
4. Monitoring and alerting recommendations

Focus on proactive measures to prevent similar errors.`;

    const userPrompt = `Error History:
${errorHistory}

${codebase ? `Codebase Info:\n${codebase}\n` : ''}
Language: ${language}

Please suggest strategies to prevent these types of errors in the future.`;

    return {
      messages: [
        {
          role: 'system',
          content: {
            type: 'text',
            text: systemPrompt,
          },
        },
        {
          role: 'user',
          content: {
            type: 'text',
            text: userPrompt,
          },
        },
      ],
    };
  }
}
