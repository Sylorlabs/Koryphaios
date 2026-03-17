# Contributing to Koryphaios

Thank you for your interest in contributing to Koryphaios. This guide covers everything you need to know whether you are a human developer or an AI coding agent.

## Getting Started

Clone the repository and install dependencies. You will need Bun 1.0 or later and Node.js 18 or later. Rust is also required if you plan to build the desktop application.

```bash
git clone <repository-url>
cd Koryphaios
bun install
```

Copy the environment template and configuration file, then configure your API keys.

```bash
cp .env.example .env
cp config.example.json koryphaios.json
```

Edit .env to add at least one LLM provider API key and generate the required secrets. Generate secure secrets using the provided script.

```bash
# Generate JWT_SECRET and KORYPHAIOS_MASTER_KEY
bun run scripts/generate-secret.ts
```

Add the generated secrets to your .env file. The JWT_SECRET and KORYPHAIOS_MASTER_KEY are required for the application to start.

## For AI Agents

Read AGENTS.md before making any changes. This file contains the module map showing what each directory does, key conventions for adding new providers and tools, and critical gotchas like using Bun instead of npm and the Svelte 5 runes syntax. The AGENTS.md file is your primary orientation document.

Key points to remember. Always use bun, never npm or yarn. Import shared types from @koryphaios/shared rather than duplicating them. Provider files should be thin adapters only with no business logic. Route handlers should delegate to core modules rather than containing orchestration logic. The frontend uses Svelte 5 runes like $state and $derived, not Svelte 4 stores.

## For Human Developers

The project is organized as a Bun monorepo with four workspaces. The backend contains the orchestration engine, provider adapters, tool implementations, and REST API. The frontend is a SvelteKit application with real-time WebSocket streaming. The shared workspace contains TypeScript types used by both frontend and backend. The desktop workspace contains the Tauri wrapper for building the desktop application.

Architecture overview. Koryphaios uses a manager worker critic architecture. The manager agent routes tasks and coordinates execution. Worker agents perform specialized tasks in isolated git worktrees. The critic agent reviews work and provides feedback. Shadow logging via git provides time travel undo and redo capabilities.

## Making Changes

Create a feature branch with a descriptive name. Make focused changes that address a single concern. Add tests for new functionality. Update documentation if you change behavior. Run the full check suite before committing.

```bash
git checkout -b feature/your-feature-name
# Make your changes
bun run check
bun run test
git commit -m "Add feature: description"
git push origin feature/your-feature-name
```

## Code Style

Use TypeScript for all new code. Follow the existing patterns in the codebase. Use explicit types rather than relying on inference for public APIs. Prefer async await over raw promises. Use early returns to reduce nesting. Write clear error messages that explain what went wrong and why.

## Testing

The backend has a test suite using Bun's built in test runner. Run tests with bun run test. For more comprehensive testing including integration tests, use bun run test:all. The frontend uses SvelteKit's testing utilities. Ensure your changes do not break existing tests and add new tests for new functionality.

## Submitting Changes

Push your branch to the repository and open a pull request. Fill out the pull request template with a clear description of what changed and why. Link any related issues. Request review from maintainers. Address feedback promptly. Once approved, your changes will be merged.

## Questions

If you are unsure about anything, check AGENTS.md for architectural context, read the docs directory for detailed guides, or open an issue to ask questions. For troubleshooting common issues, see docs/TROUBLESHOOTING.md.

## License

By contributing to Koryphaios, you agree that your contributions will be licensed under the same license as the project.
