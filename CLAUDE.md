# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pug Web SDK (`pug-web`) is a browser-side analytics/event-tracking library written in TypeScript. It auto-captures page views, clicks, scrolls, form interactions, and frustration signals (rage clicks, dead clicks), then sends them through a ConnectRPC-based transport layer that communicates with a backend via protobuf-encoded `BatchCreate` RPCs.

## Build & Development Commands

```bash
npm run build          # Compile TypeScript to dist/ (tsc)
npm run watch          # Watch mode TypeScript compilation
npm run dev            # Watch TypeScript + serve on port 3000
npm run serve          # Serve static files on port 3000
npm run lint           # Run ESLint on TypeScript files
npm run lint:fix       # Run ESLint with auto-fix
npm run format         # Format source files with Prettier
npm run format:check   # Check formatting without writing
```

**Manual testing:** After building, run `npm run serve` and open `http://localhost:3000`.

**Automated tests:** Vitest (jsdom environment). Specs live alongside source as `src/*.test.ts`. Run via `npm test` (single run) or `npm run test:watch` (watch mode).

## Architecture

### Core (`src/pug.ts`)

`pug.ts` exports `init(projectId, options)`, `track(kind, props?, opts?)`, `identify(externalId, traits?)`, `reset()`, and `destroy()`. A single nullable module-scoped `state` object (`{ config, transport, apiKey, dryRun } | null`) enforces single initialization. `init()` creates the batched transport (which internally creates the RPC transport) and iterates over tracker setup functions each wrapped in try/catch for isolation. Each tracker returns a cleanup function stored in a module-level `cleanups` array. `track()` calls `resolveSessionId()` from `session.ts` on every event, uses `toEvent()` from `track.ts` to build a protobuf `Event`, and sends it through the transport with a centralized try/catch for error safety. `destroy()` invokes all cleanup functions (each wrapped in try/catch), calls `transport.destroy()`, `destroySession()`, `destroyProfile()`, nulls the profiles client, and resets state to allow re-initialization.

### Parsers (`src/parsers.ts`)

- `initUserAgentData()` — called during `init()` to asynchronously warm a high-entropy UA cache via `navigator.userAgentData.getHighEntropyValues()`. Returns void (not a Promise); early events may lack `$osVersion` and `$device` if the promise has not resolved yet. The backend supplements these using the raw UA header.
- `parseUserAgentData()` — synchronously extracts UA Client Hints from `navigator.userAgentData`. Low-entropy props (`$browser`, `$browserVersion`, `$os`, `$mobile`) are read directly; high-entropy props (`$osVersion`, `$device`) come from the cache populated by `initUserAgentData()`. Returns `{}` on browsers without UA-CH support (Firefox, Safari).
- `parseUtmParams(search)` — extracts UTM campaign params from a query string via `URLSearchParams`. Returns only UTM params that are present in the query string with non-empty values: `$utmSource`, `$utmMedium`, `$utmCampaign`, `$utmContent`, `$utmTerm`.

### Session Tracking (`src/session.ts`)

Module-level state, no classes. Sessions are lazily initialized on the first `resolveSessionId()` call and persisted to `localStorage` under a project-namespaced key (`__pug_<projectId>_session__` via `makeStorageKey`). Expiry is evaluated lazily on each call — no timers. Cross-tab sync is handled by re-reading storage on every call; if another tab wrote a newer `lastActivityTime`, it is adopted automatically.

- `resolveSessionId()` — called by `pug.track()` on every event. Reads storage on every call (for cross-tab sync), rotates if expired, updates `lastActivityTime`, writes to storage immediately. Returns the current session ID.
- `rotate()` — generates a new uuidv7 session ID and writes it to storage immediately. Exported for users who need to force a new session (e.g. on logout).
- `configureSession(projectId, config?)` — called by `pug.init()`. Sets `idleTimeoutMinutes` (default 30) and `maxSessionMinutes` (default 1440).
- `destroySession()` — removes the storage key, resets all module state and config to defaults. Called by `pug.destroy()`.

Storage availability is checked during `configureSession()` via `isStorageAvailable()` and stored in a module-level `storage` variable (`Storage | null`). If unavailable, sessions continue in memory only.

### Profile Identity (`src/profile.ts`)

Module-level state, no classes. Manages anonymous profile IDs persisted to `localStorage` under `__pug_<projectId>_profile__`. Anonymous IDs are prefixed with `"anon-"` (required by the server for merge operations).

- `configureProfile(projectId)` — called by `pug.init()`. Sets up storage, storage keys, and restores any persisted `externalId` from a previous `identify()` call.
- `getAnonymousId()` — returns or creates a persistent `"anon-<uuidv7>"` ID.
- `resolveDistinctId()` — returns `externalId` if one has been persisted (from a previous `identify()` call, even across page loads), otherwise the anonymous ID. Called by `track()` to set the `distinctId` field on every event.
- `isIdentified()` / `markIdentified(id)` — `isIdentified()` returns `true` when `externalId` is non-empty (derived, no separate flag). `markIdentified` persists the `externalId` to localStorage so it survives page reloads. Controls whether `anonymousId` is sent on the next `identify()` RPC (first call triggers server-side merge of anonymous → identified profile; subsequent calls skip merge).
- `clearProfile()` — clears storage (both anonymous ID and external ID) and resets identified state. Called by `pug.reset()`.
- `destroyProfile()` — clears profile and resets all module state. Called by `pug.destroy()`.

`identify(externalId, traits?)` in `pug.ts` sends the `ProfilesSDKService.Identify` RPC. On the first call, it includes `anonymousId` so the server merges the anonymous profile into the identified one. Subsequent calls send an empty `anonymousId` (trait-only updates). The profiles RPC client is lazy-created on first `identify()` call. Respects `dryRun` mode.

### Well-Known Events (`src/well-known-events.ts` + `src/well-known-events.generated.ts`)

`src/well-known-events.generated.ts` is the `wellKnownSchemas` registry: a `const` object mapping every well-known event name string to its protobuf `*PropertiesSchema` descriptor imported from `@buf/fivebits_pug.bufbuild_es`. The file is generated by `scripts/gen-well-known-events.mjs` (run automatically by `prebuild`), which walks every `*PropertiesSchema` exported under `common/events/v1/*_events_pb.js`, reads the wire-name string from the `(common.events.v1.kind)` message option via `getExtension`, and filters by the `(common.events.v1.platforms)` option — events that explicitly target only non-WEB platforms (IOS/ANDROID/DESKTOP/SERVER) are excluded; events without a `platforms` annotation are treated as platform-neutral and included. Proto rather than the SDK is the single source of truth — when buf bumps and adds/renames/retargets events, the next `npm run build` re-emits the file with no hand-edits.

`src/well-known-events.ts` is the hand-written wrapper: re-exports `wellKnownSchemas` from the generated file and derives `WellKnownEventName` (the literal union of all well-known event names) and `WellKnownEventPropsMap` (mapping each name to its `MessageInitShape`) from `typeof wellKnownSchemas`. Also defines `TrackFn` (an overloaded function type: the first overload narrows properties for well-known events, the second accepts any `string` event with loose `Record<string, JsonValue>` props) and `TrackOptions`. Re-exports `JsonValue` from `@bufbuild/protobuf`.

### Event Creation (`src/track.ts`)

`toEvent(projectId, kind, sessionId, distinctId, props?, opts?)` builds a protobuf `Event` object from event kind, properties, and options. Each call generates a fresh `eventId` (uuidv7, required by the proto) and stamps `occurTime` with the current time (or `opts.timestamp` if finite). The `customProperties` field is a typed `map<string, common.v1.PropertyValue>` — a oneof over `string`, `int64` (TypeScript `bigint`), `double`, `bool`, and `Timestamp`. Two paths populate it:

- **Well-known events** (kinds present in `wellKnownSchemas`): `validateWellKnownProps` partitions input into known and extra keys, dropping extras with non-serializable types (`undefined`/`function`/`symbol`) with a warn log, then runs `create()` + `@bufbuild/protovalidate` on the known keys and returns `{ ok: true, msg, extras }` (or `{ ok: false }` on validation failure with a contextual error log). `buildKnownPropertyMap` then uses `reflect()` from `@bufbuild/protobuf/reflect` to honor the schema's explicit field presence — only fields where `r.isSet(field)` returns true are included, so an unset `scrollY` is skipped while an explicit `scrollY: 0` is preserved. For each set scalar, `scalarToPropertyValue` picks the oneof case from the field's proto scalar type (`field.scalar`) so that an integer-valued `double` field still serializes as `doubleValue`. Non-scalar fields and unknown scalar types (e.g. `BYTES`) log a warn instead of being silently dropped — today's well-known schemas only use scalars but the moment one doesn't, the maintainer needs a loud signal at SDK-bump time. Extras are then merged in via `jsValueToPropertyValue`.
- **Custom events**: every entry in `props` flows through `jsValueToPropertyValue`. Mapping: `string` → `stringValue` (truncated to 1024 UTF-8 bytes with a warn log if longer — proto's `string.max_len = 1024` is counted by protovalidate as code points, so byte-truncation is strictly more conservative); `boolean` → `boolValue`; finite `number` → `intValue` if `Number.isSafeInteger` else `doubleValue` (non-finite numbers dropped); `bigint` → `intValue`; `Date` → `timestampValue` via `timestampFromMs(d.getTime())` (`Date(NaN)` dropped); arrays/objects → `JSON.stringify` then string policy (circular structures and `toJSON` returning undefined dropped); `null`/`undefined` dropped silently (no warn — they're common and unactionable). Every other drop is logged at the call site with the property key for grep-ability, since `track()` itself never throws and undiagnosed drops would mask real user bugs.

Auto properties include: `$projectId`, `$url`, `$referrer`, `$locale`, `$screenWidth`, `$screenHeight`, `$pageTitle`, `$sdkVersion`, UA Client Hints when available (`$browser`, `$browserVersion`, `$os`, `$osVersion`, `$device`, `$mobile`), and any present UTM params. `sessionId` and `distinctId` are set as top-level fields on the `Event` proto (their own ClickHouse columns), not properties. `distinctId` is the profile identifier — `externalId` after `identify()`, otherwise the anonymous ID. After building the `Event` proto, `toEvent` validates the full `Event` object against `EventSchema` via protovalidate; invalid events are dropped with an error log. Re-exports `TrackFn`, `TrackOptions`, `JsonValue`, `WellKnownEventName`, and `WellKnownEventPropsMap` from `well-known-events.ts`.

### Transport Layer (`src/transport.ts`)

`createTransport(endpoint, apiKey)` returns an object with `send`, `sendBatch`, and `beacon` methods. It uses ConnectRPC with protobuf serialization via `@buf/fivebits_pug.bufbuild_es`. The `beacon` method uses `navigator.sendBeacon` with binary protobuf for reliable delivery during page unload; since `sendBeacon` cannot carry request headers, the API key is appended as a `?api_key=` query parameter on the beacon URL.

### RPC Client (`src/rpc.ts`)

`createRpcClients(endpoint, apiKey)` creates a ConnectRPC transport with an `x-api-key` header interceptor and returns an `eventsService` client. Uses binary format with a 5s default timeout.

### Batching Layer (`src/batch.ts`)

`createBatchedTransport(endpoint, apiKey, projectId, partialConfig?)` is the main transport factory. It creates the inner RPC transport, validates/merges batch config with defaults, and wraps everything in a batched transport that:

- Buffers events in a queue storage (localStorage-backed with in-memory fallback)
- Flushes when batch size is reached (`maxSize`, default 10) or timer expires (`maxWaitMs`, default 5s)
- Uses `sendBeacon` on `visibilitychange`/`pagehide` for reliable delivery during navigation
- Classifies errors as permanent (non-ConnectError, or ConnectError with gRPC codes 3/5/6/7/9/12/16) vs transient (retry via rollback, only for ConnectError with retryable codes)
- Has a 3-state lifecycle: `idle` → `flushing` → `idle`, or any → `destroyed`. If destroyed while flushing, the in-flight request completes normally but no further flushes are scheduled.
- Supports `immediate` flag to attempt direct send for priority events, falling back to the queue on transient errors

The queue storage implementations share a common shape with a two-phase lock/commit/rollback protocol: `lock(n)` reserves events for sending, `commit()` removes them on success, `rollback()` unreserves on failure. Two implementations: `createMemoryQueueStorage` (in-memory) and `createLocalStorageQueueStorage` (persists across page loads with debounced writes).

### Event Trackers (`src/events/`)

Each tracker module exports a `setup*Tracking(track: TrackFn)` function that returns a cleanup function. They are called during `init()`, each wrapped in try/catch to isolate failures:

| Module           | Events                      | Notes                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `page_view.ts`   | `page_view`                 | Patches `history.pushState`/`replaceState`, listens to `popstate`. Handles third-party patching gracefully: if another library patches on top, cleanup silences the orphaned wrapper instead of breaking the chain. Re-init after partial destroy reactivates orphaned wrappers without creating duplicates. |
| `click.ts`       | `click`                     | Capture-phase listener; extracts tag, id, class, text, coordinates                                                                                                                                                                                                                                       |
| `scroll.ts`      | `scroll`                    | Throttled (2s); samples scroll depth at timer expiry; cleanup clears pending timer                                                                                                                                                                                                                           |
| `form.ts`        | `form_start`, `form_submit` | Uses `WeakSet` to deduplicate; listens to input/submit                                                                                                                                                                                                                                                       |
| `frustration.ts` | `rage_click`, `dead_click`  | Split into `setupRageClickTracking` and `setupDeadClickTracking`. Rage: 3+ clicks in 1s within 40px, 1s cooldown after firing; Dead: no DOM mutation or URL change within 500ms, cleanup disconnects MutationObserver and clears pending timers                                                              |

### Push Notifications (`src/push.ts`, `pug_sw.js`)

Push is an optional, tree-shakeable module — `pug.ts` never imports it, so non-push users pay zero bundle cost.

**`src/push.ts`** exports three functions:

- `subscribePush(vapidPublicKey, options)` — registers the service worker at `options.swPath` (default `/pug_sw.js`), waits for it to become active, subscribes via VAPID, generates/retrieves a persistent `deviceId` from `localStorage` (`pug_device_id`), and calls `DevicesService.Subscribe`. Requires `options.endpoint` and `options.apiKey` (same values passed to `init()`). Does not read pug's internal state.
- `unsubscribePush(options?)` — unsubscribes the push subscription from `pushManager`.
- `setupNotificationClickTracking(track)` — sets up `notification_clicked` tracking across two cases: (1) page already open: listens for a `pug_notification_click` postMessage from the SW; (2) page opened by the click: reads `?pug_nc=<JSON>` from the URL, calls `track`, strips the param with `history.replaceState`. Returns a cleanup function.

**`pug_sw.js`** (project root, copy to public dir) — drop-in service worker. Handles `install`/`activate`/`push`/`notificationclick`. On `notificationclick`: if a page is open, sends a postMessage to the first matched window (which is then focused); if no page is open, opens `targetUrl?pug_nc=<data>` so `setupNotificationClickTracking` can read it on load.

### Utilities (`src/utils.ts`)

- `makeStorageKey(projectId, name)` — generates a namespaced localStorage key.
- `urlBase64ToUint8Array(base64String)` — converts a VAPID public key from base64url to `Uint8Array<ArrayBuffer>` for `pushManager.subscribe()`.
- `isStorageAvailable()` — probes localStorage with a write/remove sentinel. Returns `true` if available, `false` if blocked (private mode, quota, security policy). Used by `session.ts`, `batch.ts`, `profile.ts`, and `push.ts`.

### Key Patterns

- Trackers receive a `track` function and call it directly — they do not access the transport. All browser event listeners are attached globally (document/window level) during `init()` and removed during `destroy()`.
- Use `const = () =>` arrow functions everywhere. The only exceptions are `function` expressions that need `this` binding (e.g., history method wrappers in `page_view.ts`).
- Events are protobuf `Event` objects created via `toEvent()`, not plain JS objects.

### Design Invariants

- **`track()` must never throw.** It is wrapped in a centralized try/catch (with defensive logging via the internal `log` module) and any transport errors are caught via `.catch()`. Because trackers call `track()` from places like monkey-patched `history.pushState`/`replaceState`, an exception would break the host application. Callers may rely on `track()` being safe to call without their own error handling.

## TypeScript & Module Setup

- Target/module: ES2020, strict mode, declarations emitted to `dist/`
- Imports within `src/` use `.js` extensions (required for ES module resolution at runtime)
- Module resolution: `bundler`
- Barrel export: `src/index.ts` re-exports `init`, `destroy`, `track`, `reset`, `identify`, `rotate` and types `PugConfig`, `InitOptions`, `BatchConfig`, `TrackOptions`, `SessionConfig`, `JsonValue`, `JsonObject`, `TrackFn`, `WellKnownEventName`, `WellKnownEventPropsMap`; and from `push.ts`: `subscribePush`, `unsubscribePush`, `setupNotificationClickTracking`, `PushOptions`. `JsonValue` and `JsonObject` are re-exported from `@bufbuild/protobuf`. Deprecated alias `PugEventName` (→ `WellKnownEventName`) is re-exported for backward compatibility. Internal module functions and implementation details are not publicly exported.
