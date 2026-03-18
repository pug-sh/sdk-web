# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cotton Web SDK (`cotton-web`) is a browser-side analytics/event-tracking library written in TypeScript. It auto-captures page views, clicks, scrolls, form interactions, and frustration signals (rage clicks, dead clicks), then sends them through a ConnectRPC-based transport layer that communicates with a backend via protobuf-encoded `BatchCreate` RPCs.

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

`cotton.ts` exports `init(projectId, options)`, `track(kind, props?, opts?)`, and `destroy()`. A single nullable module-scoped `state` object (`{ config, transport } | null`) enforces single initialization. `init()` creates the batched transport (which internally creates the RPC transport) and iterates over tracker setup functions, each wrapped in try/catch for isolation. Each tracker returns a cleanup function stored in a module-level `cleanups` array. `track()` uses `toEvent()` from `track.ts` to build a protobuf `Event` enriched with `projectId`, `url`, `referrer`, `userAgent`, and timestamp, then sends it through the transport with a centralized try/catch for error safety. `destroy()` invokes all cleanup functions (each wrapped in try/catch), calls `transport.destroy()`, and resets state to allow re-initialization.

### Auto Properties (`src/parsers.ts`)

Pure utility functions for enriching events with environment context — no DOM or window API access, fully testable in isolation:

- `parseBrowser(nav)` — detects browser name and first (major) version number. Accepts a `NavigatorLike` object; uses `userAgentData.brands` when available, otherwise falls back to UA string parsing. Priority order: Edge, Opera, Samsung Browser (brand `"Samsung Internet"`), UC Browser, Chrome/Chromium, Firefox, Safari. Falls back to `{ browser: "Other", browserVersion: "" }`.
- `parseOs(nav)` — detects OS, version, and device type. Accepts a `NavigatorLike` object; uses `userAgentData.platform`/`mobile` when available (no OS version — high-entropy only), otherwise falls back to UA string parsing. iOS (iPhone, iPad, iPod) is checked before Mac OS X because iOS UAs contain both device tokens and "Mac OS X"; iPad classified as Tablet (via `/iPad/` in UA or `mobile === false` in uaData), iPhone/iPod as Mobile. Detects: iOS, Android, Windows (NT version mapped to readable name — NT 10.0 covers both Windows 10 and 11), Mac OS X, Linux. Known limitation: iPadOS 13+ reports a desktop Mac UA, so those devices are classified as Mac OS X/Desktop when using UA string fallback. Falls back to `{ os: "Other", osVersion: "", deviceType: "Desktop" }`.
- `parseUtmParams(search)` — extracts UTM campaign params from a query string via `URLSearchParams`. Returns only present, non-empty keys: `$utmSource`, `$utmMedium`, `$utmCampaign`, `$utmContent`, `$utmTerm`.

### Event Creation (`src/track.ts`)

`toEvent(projectId, kind, props?, opts?)` builds a protobuf `Event` object from event kind, properties, and options. It splits properties into `autoProperties` (SDK-injected, all keys prefixed with `$`) and `customProperties` (user-provided), serializing non-string values via `JSON.stringify`. Auto properties include: `$projectId`, `$url`, `$referrer`, `$userAgent`, `$browser`, `$browserVersion`, `$os`, `$osVersion`, `$deviceType`, `$locale`, `$screenWidth`, `$screenHeight`, `$pageTitle`, `$sdkVersion`, and any present UTM params. Also exports `TrackFn<T>` (generic callback type used by all trackers) and `TrackOptions` (supports `immediate` and `timestamp`).

### Transport Layer (`src/transport.ts`)

`createTransport(endpoint, token)` returns an object with `send`, `sendBatch`, and `beacon` methods. It uses ConnectRPC with protobuf serialization via `@buf/fivebits_cotton.bufbuild_es`. The `beacon` method uses `navigator.sendBeacon` with binary protobuf for reliable delivery during page unload; since `sendBeacon` cannot carry request headers, the API key is appended as a `?x-api-key=` query parameter on the beacon URL.

### RPC Client (`src/rpc.ts`)

`createRpcClients(endpoint, token)` creates a ConnectRPC transport with an `x-api-key` header interceptor and returns `eventsService` and `profileService` clients. Uses binary format with a 5s default timeout.

### Batching Layer (`src/batch.ts`)

`createBatchedTransport(endpoint, token, projectId, partialConfig?)` is the main transport factory. It creates the inner RPC transport, validates/merges batch config with defaults, and wraps everything in a batched transport that:

- Buffers events in a queue storage (localStorage-backed with in-memory fallback)
- Flushes when batch size is reached (`maxSize`, default 10) or timer expires (`maxWaitMs`, default 5s)
- Uses `sendBeacon` on `visibilitychange`/`pagehide` for reliable delivery during navigation
- Classifies errors as permanent (non-ConnectError, or ConnectError with gRPC codes 3/5/6/7/9/12/16) vs transient (retry via rollback, only for ConnectError with retryable codes)
- Has a 3-state lifecycle: `idle` → `flushing` → `idle`, or any → `destroyed`. If destroyed while flushing, the in-flight request completes normally but no further flushes are scheduled.
- Supports `immediate` flag to attempt direct send for priority events, falling back to the queue on transient errors

The queue storage implementations share a common shape with a two-phase lock/commit/rollback protocol: `lock(n)` reserves events for sending, `commit()` removes them on success, `rollback()` unreserves on failure. Two implementations: `createMemoryQueueStorage` (in-memory) and `createLocalStorageQueueStorage` (persists across page loads with debounced writes).

### Event Trackers (`src/events/`)

Each tracker module exports a `setup*Tracking(track: TrackFn<EventName>)` function that returns a cleanup function. They are called during `init()`, each wrapped in try/catch to isolate failures:

| Module           | Events                      | Notes                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `page_view.ts`   | `page_view`                 | Patches `history.pushState`/`replaceState`, listens to `popstate`. Handles third-party patching gracefully: if another library patches on top, cleanup silences the orphaned wrapper instead of breaking the chain. Re-init after partial destroy reactivates orphaned wrappers without creating duplicates. |
| `click.ts`       | `click`                     | Capture-phase listener; extracts tag, id, className, text, coordinates                                                                                                                                                                                                                                       |
| `scroll.ts`      | `scroll`                    | Throttled (2s); samples scroll depth at timer expiry; cleanup clears pending timer                                                                                                                                                                                                                           |
| `form.ts`        | `form_start`, `form_submit` | Uses `WeakSet` to deduplicate; listens to input/submit                                                                                                                                                                                                                                                       |
| `frustration.ts` | `rage_click`, `dead_click`  | Split into `setupRageClickTracking` and `setupDeadClickTracking`. Rage: 3+ clicks in 1s within 40px, 1s cooldown after firing; Dead: no DOM mutation or URL change within 500ms, cleanup disconnects MutationObserver and clears pending timers                                                              |

### Key Patterns

- Trackers receive a `track` function and call it directly — they do not access the transport. All browser event listeners are attached globally (document/window level) during `init()` and removed during `destroy()`.
- Use `const = () =>` arrow functions everywhere. The only exceptions are `function` expressions that need `this` binding (e.g., history method wrappers in `page_view.ts`).
- Events are protobuf `Event` objects created via `toEvent()`, not plain JS objects.

### Design Invariants

- **`track()` must never throw.** It is wrapped in a centralized try/catch (with defensive `console.error` logging) and any transport errors are caught via `.catch()`. Because trackers call `track()` from places like monkey-patched `history.pushState`/`replaceState`, an exception would break the host application. Callers may rely on `track()` being safe to call without their own error handling.

## TypeScript & Module Setup

- Target/module: ES2020, strict mode, declarations emitted to `dist/`
- Imports within `src/` use `.js` extensions (required for ES module resolution at runtime)
- Module resolution: `bundler`
- Barrel export: `src/index.ts` re-exports `init`, `destroy`, `track` and types `CottonConfig`, `CottonEventName`, `InitOptions`, `BatchConfig`, `JSONValue`, `TrackOptions`. Internal module functions and implementation details are not publicly exported.
