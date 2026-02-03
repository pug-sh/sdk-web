# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cotton Web SDK (`cotton-web`) is a browser-side analytics/event-tracking library written in TypeScript. It auto-captures page views, clicks, scrolls, form interactions, and frustration signals (rage clicks, dead clicks), then sends them through a pluggable transport layer (currently a mock console-logging implementation, intended to be replaced with a ConnectRPC client).

## Build & Development Commands

```bash
npm run build          # Compile TypeScript to dist/ (tsc)
npm run watch          # Watch mode TypeScript compilation
npm run dev            # Watch TypeScript + serve on port 3000
npm run serve          # Serve static files on port 3000
```

**Manual testing:** After building, run `npm run serve` and open `http://localhost:3000`. No automated test framework is configured.

## Architecture

### Core (`src/cotton.ts`)

`cotton.ts` exports `init(projectId, options?)`, `track(eventName, properties?)`, and `destroy()` functions. A single nullable module-scoped `state` object (`{ config, transport } | null`) enforces single initialization. `init()` creates the transport and iterates over tracker setup functions, each wrapped in try/catch for isolation. Each tracker returns a cleanup function stored in a module-level `cleanups` array. `track()` enriches events with `projectId`, `url`, `referrer`, `userAgent`, and `timestamp` before sending through the transport, with a centralized try/catch for error safety. `destroy()` invokes all cleanup functions (each wrapped in try/catch), calls `transport.destroy?.()`, and resets state to allow re-initialization.

### Transport Layer (`src/transport.ts`)

`Transport` interface with `send(event: EventData): Promise<void>` and an optional `destroy?(): void` method for cleanup. `createTransport(endpoint)` is a factory function that currently returns a console-logging mock. The module also exports `JsonValue` (recursive type-safe JSON value type) and `TrackFn<T>` (generic callback type used by all trackers). New transport backends should implement the `Transport` interface.

### Event Trackers (`src/events/`)

Each tracker module exports a `setup*Tracking(track: TrackFn<EventName>): () => void` function that returns a cleanup function. They are called during `init()`, each wrapped in try/catch to isolate failures:

| Module           | Events                      | Notes                                                                                                                                                         |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page_view.ts`   | `page_view`                 | Patches `history.pushState`/`replaceState`, listens to `popstate`. Handles third-party patching gracefully: if another library patches on top, cleanup silences the orphaned wrapper instead of breaking the chain. Re-init after partial destroy reactivates orphaned wrappers without creating duplicates. |
| `click.ts`       | `click`                     | Capture-phase listener; extracts tag, id, className, text, coordinates                                                                                        |
| `scroll.ts`      | `scroll`                    | Throttled (2s); samples scroll depth at timer expiry; cleanup clears pending timer                                                                            |
| `form.ts`        | `form_start`, `form_submit` | Uses `WeakSet` to deduplicate; listens to input/submit                                                                                                        |
| `frustration.ts` | `rage_click`, `dead_click`  | Split into `setupRageClickTracking` and `setupDeadClickTracking`. Rage: 3+ clicks in 1s within 40px, 1s cooldown after firing; Dead: no DOM mutation or URL change within 500ms, cleanup disconnects MutationObserver and clears pending timers |

### Key Pattern

Trackers receive a `track` function and call it directly — they do not access the transport. All browser event listeners are attached globally (document/window level) during `init()` and removed during `destroy()`.

### Design Invariants

- **`track()` must never throw.** It is wrapped in a centralized try/catch (with defensive `console.error` logging) and any transport errors are caught via `.catch()`. Because trackers call `track()` from places like monkey-patched `history.pushState`/`replaceState`, an exception would break the host application. Callers may rely on `track()` being safe to call without their own error handling.

## TypeScript & Module Setup

- Target/module: ES2020, strict mode, declarations emitted to `dist/`
- Imports within `src/` use `.js` extensions (required for ES module resolution at runtime)
- Module resolution: `bundler`
- Barrel export: `src/index.ts` re-exports `init`, `track`, `destroy`, `CottonConfig`, `CottonEventName` from cotton, and `createTransport`, `EventData`, `JsonValue`, `TrackFn`, `Transport` from transport
