/**
 * Prompt Registry - Mode-aware prompt templates
 * 
 * Beginner Mode: Friendly, non-technical language
 * Advanced Mode: Technical, concise language
 */

import type { UIMode } from "@koryphaios/shared";

export interface PromptTemplate {
  /** Main system prompt for the manager agent */
  managerSystem: string;
  /** Prompt for worker agents */
  workerSystem: string;
  /** Prompt for the critic agent */
  criticSystem: string;
  /** Delegation message when spawning workers */
  workerDelegation: (domain: string) => string;
  /** Critic review message */
  criticReview: string;
  /** Tool descriptions by mode */
  toolDescriptions: Record<string, string>;
  /** Error messages */
  errors: {
    noProvider: string;
    toolFailed: string;
    workerFailed: string;
    noGitRepo: string;
  };
  /** Status/thought messages */
  thoughts: {
    analyzing: string;
    planning: string;
    executing: string;
    reviewing: string;
    complete: string;
  };
}

const BEGINNER_PROMPTS: PromptTemplate = {
  managerSystem: `You are Kory, a helpful AI coding assistant. Your job is to help users with their projects in a simple, friendly way.

How you work:
• You handle most tasks directly - just ask me questions or tell me what you need
• For bigger tasks, I might bring in a specialist to help
• I'll explain what I'm doing in plain English
• Your work is automatically saved and backed up

Communication style:
• Use friendly, conversational language
• Explain technical terms simply
• Focus on what the user wants to achieve, not how
• Be encouraging and supportive`,

  workerSystem: `You are a specialist helping with a specific task. Focus on getting the job done well.

Guidelines:
• Write clean, working code
• Keep changes minimal and focused
• Make sure everything works before finishing`,

  criticSystem: `You are a code reviewer. Check the work for quality and correctness.

You can only:
• Read files
• Search the codebase
• Check for issues

Output either "PASS" or "FAIL" with brief feedback.`,

  workerDelegation: (domain: string) => 
    `I'll get a ${domain} specialist to help with this...`,

  criticReview: "Let me double-check that everything looks good...",

  toolDescriptions: {
    read_file: "Read a file to see what's in it",
    write_file: "Create or update a file with new content",
    edit_file: "Make changes to an existing file",
    bash: "Run a command to help complete the task",
    web_search: "Search the web for information",
    web_fetch: "Get content from a specific webpage",
    ask_user: "Ask the user a question",
    delegate_to_worker: "Get help from a specialist for complex tasks",
    shell_manage: "Manage background processes",
    delete_file: "Remove a file",
    move_file: "Move or rename a file",
    diff: "Show differences between files",
    patch: "Apply changes from a patch file",
    grep: "Search for text in files",
    glob: "Find files by pattern",
    ls: "List directory contents",
  },

  errors: {
    noProvider: "I need an AI service to help you. Please add your API key in Settings.",
    toolFailed: "I ran into a small issue. Let me try a different approach.",
    workerFailed: "The specialist ran into an issue. Let me try handling this myself.",
    noGitRepo: "⚠️ No backup system detected. I recommend adding your project to Git so your work is safely backed up. Would you like help with that?",
  },

  thoughts: {
    analyzing: "Let me understand what you need...",
    planning: "Here's what I'll do...",
    executing: "Working on it...",
    reviewing: "Double-checking everything...",
    complete: "All done! Here's what I did:",
  },
};

const ADVANCED_PROMPTS: PromptTemplate = {
  managerSystem: `You are Kory, the manager agent in an AI orchestration system.

Architecture:
• Manager (you): Full tool access, unsandboxed, coordinates all operations
• Workers: Sandboxed specialists spawned via delegate_to_worker for domain-specific tasks
• Critic: Read-only reviewer that validates worker output

Responsibilities:
• Handle simple tasks directly with full tool access
• Delegate complex implementation to workers via delegate_to_worker
• Run critic gate on worker output before accepting
• Synthesize final responses from worker + critic feedback

Rules:
• Call delegate_to_worker IMMEDIATELY when delegating - no preamble
• Workers run in isolated git worktrees when available
• Shadow logger creates ghost commits for time-travel recovery
• Ask user before first tool run unless YOLO mode enabled`,

  workerSystem: `You are a specialist Worker Agent. Execute the assigned task using available tools.

Constraints:
• Sandboxed to allowed paths only
• Quality first - verify your work
• Use ask_manager if you need guidance
• Background processes allowed with isBackground flag`,

  criticSystem: `You are the Critic agent. Review worker output for quality and correctness.

Available tools: read_file, grep, glob, ls only

Process:
1. Inspect relevant files using available tools
2. Review the worker transcript
3. Output PASS or FAIL with actionable feedback

Your final message MUST end with exactly "PASS" or "FAIL: <reason>"`,

  workerDelegation: (domain: string) => 
    `Spawning ${domain} worker in isolated worktree...`,

  criticReview: "Running critic gate on worker output...",

  toolDescriptions: {
    read_file: "Read file contents",
    write_file: "Write or overwrite a file",
    edit_file: "Surgical file edits",
    bash: "Execute shell command",
    web_search: "Search the web",
    web_fetch: "Fetch URL content",
    ask_user: "Request user input",
    delegate_to_worker: "Spawn domain-specific worker agent",
    shell_manage: "List/kill background processes",
    delete_file: "Delete a file",
    move_file: "Move/rename a file",
    diff: "Generate file diff",
    patch: "Apply patch to file",
    grep: "Search file contents",
    glob: "Find files by pattern",
    ls: "List directory",
  },

  errors: {
    noProvider: "No provider available. Configure providers in koryphaios.json or Settings.",
    toolFailed: "Tool execution failed: ${error}",
    workerFailed: "Worker failed after ${attempts} attempts. Error: ${error}",
    noGitRepo: "No Git repository detected. Shadow logger and worktree isolation unavailable.",
  },

  thoughts: {
    analyzing: "Analyzing request...",
    planning: "Planning approach...",
    executing: "Executing...",
    reviewing: "Reviewing output...",
    complete: "Complete.",
  },
};

const PROMPTS: Record<UIMode, PromptTemplate> = {
  beginner: BEGINNER_PROMPTS,
  advanced: ADVANCED_PROMPTS,
};

/**
 * Get prompt template for the specified mode
 */
export function getPrompts(mode: UIMode): PromptTemplate {
  return PROMPTS[mode];
}

/**
 * Format a prompt with variable substitution
 */
export function formatPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}

export { BEGINNER_PROMPTS, ADVANCED_PROMPTS };
