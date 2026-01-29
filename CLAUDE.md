# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cotton Web SDK (`cotton-web`) is a browser-side analytics/event-tracking library written in TypeScript. It auto-captures page views, clicks, scrolls, form interactions, and frustration signals (rage clicks, dead clicks), then sends them through a pluggable transport layer (currently a placeholder gRPC implementation).

## Build & Development Commands

```bash
npm run build          # Compile TypeScript to dist/ (tsc)
npm run watch          # Watch mode TypeScript compilation
node build.js          # Bundle with esbuild → dist/bundle.js (ESM, sourcemaps, es2020, browser)
node server.js         # Start Express dev server on port 8080
```

**Manual testing:** After building, run the dev server and open `http://localhost:8080/manual_test.html`. No automated test framework is configured.

## Architecture

### Singleton Core (`src/cotton.ts`)

`Cotton` uses a private constructor + static `init(projectId, options?)` pattern. Initialization creates the singleton, wires up the transport, and registers all event trackers. The `track(eventName, properties)` method enriches events with `projectId`, `url`, `referrer`, `userAgent`, and `timestamp` before sending through the transport.

### Transport Layer (`src/transport.ts`)

`Transport` interface with a single `send(event: EventData): Promise<void>` method. `GrpcTransport` is currently a console-logging placeholder. New transport backends should implement the `Transport` interface.

### Event Trackers (`src/events/`)

Each tracker module exports a `setup*Tracking(cotton: Cotton)` function called during `initTrackers()`:

| Module | Events | Notes |
|--------|--------|-------|
| `page_view.ts` | `page_view` | Patches `history.pushState`/`replaceState`, listens to `popstate` |
| `click.ts` | `click` | Capture-phase listener; extracts tag, id, className, text, coordinates |
| `scroll.ts` | `scroll` | Throttled (2s); reports scroll depth percentage |
| `form.ts` | `form_start`, `form_submit` | Uses `WeakSet` to deduplicate; listens to focus/input/submit |
| `frustration.ts` | `rage_click`, `dead_click` | Rage: 3+ clicks in 1s within 40px; Dead: no DOM mutation or URL change within 500ms |

### Key Pattern

Trackers receive the `Cotton` instance and call `cotton.track()` — they do not access the transport directly. All browser event listeners are attached globally (document/window level) during construction.

## TypeScript & Module Setup

- Target/module: ES2020, strict mode, declarations emitted to `dist/`
- Imports within `src/` use `.js` extensions (required for ES module resolution at runtime)
- Barrel export: `src/index.ts` re-exports `Cotton`, `CottonConfig`, `Transport`, `EventData`, `GrpcTransport`
