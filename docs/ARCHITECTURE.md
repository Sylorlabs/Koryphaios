# Koryphaios Architecture

This document describes the high-level architecture of Koryphaios, an AI Agent Orchestration Dashboard.

## Core Concepts

### Manager-Worker Model
Koryphaios uses a hierarchical agent model:
1. **Manager (Kory)**: The central orchestrator. It receives user requests, analyzes them, and delegates tasks to specialized workers.
2. **Workers**: Specialized agents (UI, Backend, Test, etc.) that execute specific tasks. They have full access to tools but are scoped to a single domain.
3. **Critic**: A quality assurance agent that reviews worker output before it is presented to the user.

### Provider Registry
The `ProviderRegistry` (`backend/src/providers/registry.ts`) is the universal authentication and routing hub.
- **Unified Interface**: All LLM providers (Anthropic, OpenAI, Gemini, etc.) implement a common `Provider` interface.
- **Auto-Detection**: It automatically detects API keys from environment variables, CLI tools (gh, glcloud, gemini), and config files.
- **Routing**: It resolves which provider to use for a requested model ID.
- **Resilience**: It implements a Circuit Breaker pattern to failover to alternative providers if one is down or rate-limited.

### Tool System
Tools are executable units of code that agents can invoke.
- **Registry**: `ToolRegistry` manages available tools.
- **Execution**: Tools are executed in a sandboxed context (`ToolContext`) with access to the filesystem and session state.
- **Streaming**: Tool execution results are streamed back to the frontend via WebSockets.

### Event-Driven Architecture
The backend uses a pub/sub system (`wsBroker`) to broadcast events to the frontend.
- **Events**: `agent.spawned`, `agent.status`, `stream.delta`, `stream.tool_call`, etc.
- **State**: The frontend reconstructs the agent state from these events.

## Data Flow

1. **User Request**: User sends a message via WebSocket/HTTP.
2. **Manager Analysis**: Kory analyzes the request and decides if it needs a worker.
3. **Delegation**: If a worker is needed, Kory spawns a worker agent with a specific domain (e.g., "ui").
4. **Execution**: The worker executes the task using tools (read_file, write_file, etc.).
5. **Verification**: The Critic agent reviews the changes.
6. **Response**: The final result is streamed back to the user.

## Directory Structure

- `backend/src/kory`: Agent orchestration logic.
- `backend/src/providers`: LLM provider integrations.
- `backend/src/tools`: Built-in tools.
- `backend/src/plugins`: Local, project-specific tools.
- `shared/src`: Shared types and constants.
