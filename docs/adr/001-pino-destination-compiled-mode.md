# ADR-001: pino with synchronous file destination for compiled mode

## Status

Accepted

## Context

The backend runs in two modes:
1. **Development** — `bun run` with TypeScript source, output to terminal
2. **Compiled/Production** — Bun compiled binary, no terminal, needs file logging

The prior logger was disabled in production (`if (DEV) pino(...) else {}`) because:
- `pino-pretty` requires native bindings that don't work in compiled binaries
- Async logging to stdout doesn't work when there's no TTY
- The original author left a "For now" comment and moved on

This meant **all production logs were silently discarded**. Crashes, errors, and warnings were invisible. Debugging production issues required reproducing locally.

## Decision

Use a two-mode logger:
- **Development**: `pino-pretty` to stdout (TTY detection for color)
- **Compiled/Production**: `pino.destination()` for synchronous file logging with daily rotation

The `teeDest` object wraps both a file destination and a console fallback, cast to `pino.DestinationStream` for type compatibility.

## Consequences

- **Positive**: All production logs are captured in rotating files under `logs/`.
- **Positive**: Structured JSON logs in production (pino format) for machine parsing.
- **Positive**: Synchronous writes ensure logs are flushed before a crash.
- **Negative**: Synchronous file I/O has a small performance cost per log line.
- **Negative**: Daily rotation requires manual cleanup of old log files.

## Alternatives considered

- **Winston**: Heavier, more config, no better for compiled binaries.
- **Console.log only**: Lost in compiled mode (no TTY).
- **Async file logging**: Logs could be lost on crash (buffer not flushed).
