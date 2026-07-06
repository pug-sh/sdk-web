# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pug Web SDK (`pug-web`) is a browser-side analytics/event-tracking library written in TypeScript. It auto-captures page views, clicks, scrolls, form interactions, and frustration signals (rage clicks, dead clicks), then sends them through a ConnectRPC-based transport layer that communicates with a backend via protobuf-encoded `BatchCreate` RPCs.

## Build & Development Commands

```bash
bun install            # Install dependencies
bun run build          # Compile TypeScript to dist/ (runs prebuild codegen, then tsc)
bun run watch          # Watch-mode TypeScript compilation
bun run dev            # Watch TypeScript + serve on port 3000
bun run serve          # Serve static files on port 3000
bun run lint           # Lint & auto-fix with Biome (biome check --write .)
bun run format         # Format source files with Biome (biome format --write .)
bun run test           # Run tests once (vitest run)
bun run test:watch     # Run tests in watch mode (vitest)
```

**Manual testing:** After building, run `bun run serve` and open `http://localhost:3000`.

**Automated tests:** Vitest (jsdom environment). Specs live alongside source as `src/*.test.ts`. Run via `bun run test` (single run) or `bun run test:watch` (watch mode). Use `bun run test`, not `bun test` — the latter invokes Bun's built-in test runner instead of Vitest.

## Architecture

### Core (`src/pug.ts`)

`pug.ts` exports `init(projectId, options)`, `track(kind, props?, opts?)`, `identify(externalId, traits?)`, `reset()`, `destroy()`, `setAutoCapture(selection)`, `optInTracking()`, `optOutTracking()`, `isTrackingEnabled()`, and `getTrackingConsent()`. A single nullable module-scoped `state` object (`{ config, transport, apiKey, dryRun, autoCapture, trackingConsent } | null`) enforces single initialization. `init()` builds the shared `PersistentStore` (from `crossSubdomainTracking`, default `false` — see Cross-Subdomain Persistence) and passes it to `configureSession`, `configureProfile`, and `createTrackingConsent` (the tracking-consent controller is created before `configureProfile` so the latter's init-time identity-cookie expiry refresh can be gated on `isGranted` — no identity write while consent is denied); creates the batched transport (which internally creates the RPC transport); creates the auto-capture controller (the auto-capture controller owns the desired selection and gates listeners on consent via an injected `isGranted` getter); and applies the selection with `setDesired()`. `trackingConsent` sets the initial consent and optional persistence (`'granted'`/`'denied'`, or `{ default?, persist? }`); while denied, automatic listeners stay off, `track()` and `identify()` drop calls at debug level, and no events are queued. With `persist: true` the choice is stored through the shared `PersistentStore` (riding the cross-subdomain cookie when active, otherwise `localStorage`) and restored on the next `init()`; otherwise consent is in-memory and callers pass the initial value on each `init()`. `optOutTracking()` revokes consent, re-reconciles (tearing listeners down), and tears down persisted identity (`clearProfile()` + `clearSession()`) so no identifiers linger for a user who opted out — in cross-subdomain mode this clears the shared cookie so the opt-out propagates to sibling subdomains, while the persisted consent itself is kept (device-level); `optInTracking()` re-reconciles, restoring the stored selection (a fresh identity is created lazily on the next event). `track()` calls `resolveSessionId()` from `session.ts` on every allowed event, uses `toEvent()` from `track.ts` to build a protobuf `Event`, and sends it through the transport with a centralized try/catch for error safety. `destroy()` invokes active tracker cleanup functions through the auto-capture controller, calls `transport.destroy()`, `destroySession()`, `destroyProfile()`, nulls the profiles client, and resets state to allow re-initialization; it releases runtime resources without clearing persisted identity (that is `reset()`'s job), so a subsequent `init()` resumes the same session and profile.

### Auto-Capture (`src/auto-capture.ts`)

Owns SDK automatic listener selection and lifecycle. `autoCapture` supports `true`/`false` or an `AutoCaptureSelection` object; object mode is an allowlist, so only keys set to `true` are enabled and omitted keys stay off. Runtime tracker cleanup is owned per tracker in a controller-local `Map`, allowing `setAutoCapture()` to add/remove SDK-owned listeners after init without bloating `pug.ts`.

### Cross-Subdomain Persistence (`src/cookie.ts`, `src/persistence.ts`)

Identity is shared across subdomains by mirroring it into a first-party cookie on the registrable domain. **Off by default** (`crossSubdomainTracking` defaults to `false`): cross-subdomain identity relaxes browser same-origin isolation to the weaker same-site model, so per `docs/cross-domain-tracking-threat-model.md` §7 it is an explicit per-integrator opt-in, never inferred. `createCookieLayer(config, doc?)` in `cookie.ts` takes `CrossSubdomainConfig` (`boolean | { domain }`): `false` (the default) returns `null` (no cookie layer, origin-scoped `localStorage` only); `true` (explicit opt-in) discovers the widest settable domain (eTLD+1) via `seekRegistrableDomain()` — a write-probe that tries `domain=.<candidate>` widest-first and takes the first cookie the browser accepts, so public suffixes (`.com`, `.co.uk`) are rejected by the browser itself with no bundled suffix list; `{ domain }` pins an explicit domain (verified with a probe; on rejection or host mismatch it warns and falls back to host-only). Host-only (empty domain attribute) is also used on localhost and IP hosts; PSL-listed multi-tenant PaaS hosts (herokuapp.com, vercel.app, …) need no special-casing, since their shared suffix is a public suffix the browser rejects, so the widest-first probe lands on the tenant's own host. **Not covered:** a custom multi-tenant registrable domain *not* on the Public Suffix List (e.g. `a.myplatform.com` / `b.myplatform.com` as separate tenants) — the probe accepts `.myplatform.com` and sibling tenants can read each other's identity (threat model T2/T3); there is no bundled denylist backstop, so such deployments must pass an explicit `{ domain }`. The public API JSDoc warns integrators of this. Cookies are written as `<key>=<encodeURIComponent(value)>; SameSite=Lax; path=/[; domain=.X][; secure]; max-age=<365d>`, capped at 3800 chars (warn + skip), with read-back verification. In cross-subdomain mode both `get()` and `set()` reconcile a stale host-only twin on first access per key (`reconcileTwin`): the twin is expired so it can neither shadow the shared cookie on reads nor — via a read-then-refresh (`getAnonymousId`, session activity) — be promoted onto the shared cookie and corrupt identity site-wide; if expiring it leaves nothing, the twin was the sole value (a host-only → shared migration) and is re-promoted to the shared cookie so siblings inherit it. The `doc` parameter is injectable so tests target other origins via jsdom documents over a shared `CookieJar`.

`createPersistentStore(cookieLayer)` in `persistence.ts` returns a `PersistentStore` (`getItem`/`setItem`/`removeItem`/`crossSubdomain`) layering the cookie over `localStorage`: reads prefer the cookie (the shared source of truth — stale per-origin localStorage must not shadow it), writes go to every available layer (`setItem` returns true only if the value will be readable on the next load: the cookie write must land in cross-subdomain mode, any layer suffices otherwise); `removeItem` returns true only when a subsequent read would miss — every consulted layer confirmed the delete — so opt-out/reset can surface a teardown that did not land; methods never throw. Returns `null` only when both layers are unusable. `configureSession`/`configureProfile`/`createTrackingConsent` accept the store as an optional trailing parameter and default to a localStorage-only store when it is omitted (internal callers other than `pug.init()`, tests). Restore paths re-write the restored value once per `init()` so a cookie-backed store refreshes its 365-day expiry for active users; the profile's `externalId` refresh is additionally gated on tracking consent (no identity cookie write while denied). The batch queue and the tab registry intentionally stay on raw `localStorage` (origin-local, too chatty/large for a header-bearing channel).

### Tracking Consent (`src/tracking-consent.ts`)

Owns the consent state (`TrackingConsent`: `'granted' | 'denied'`). `createTrackingConsent(projectId, config?, store?)` takes `config: TrackingConsent | { default?, persist? }`; `default` is the first-run seed. By default consent is in-memory; with `persist: true` the factory stores opt in/out through the `PersistentStore` (key `__pug_<projectId>_consent__` via `makeStorageKey`; rides the cross-subdomain cookie when active, so an opt-out on one subdomain applies on siblings) and restores any valid persisted value on construction, so it survives reloads. When storage is unavailable it warns (once per `init()`) and falls back to in-memory. `destroy()` and `reset()` do not clear persisted consent — it is device-level by design. The auto-capture controller stores the desired `autoCapture` selection and gates listener attachment on consent (read through an injected `isGranted` getter), so `setAutoCapture()` can be called before opt-in and the selection is re-applied on `optInTracking()`. When `init()` runs with consent denied it logs a one-time `log.warn`; integrators can detect the state via `isTrackingEnabled()`.

### Parsers (`src/parsers.ts`)

- `initUserAgentData()` — called during `init()` to asynchronously warm a high-entropy UA cache via `navigator.userAgentData.getHighEntropyValues()`. Returns void (not a Promise); early events may lack `$osVersion` and `$device` if the promise has not resolved yet. The backend supplements these using the raw UA header.
- `parseUserAgentData()` — synchronously extracts UA Client Hints from `navigator.userAgentData`. Low-entropy props (`$browser`, `$browserVersion`, `$os`, `$mobile`) are read directly; high-entropy props (`$osVersion`, `$device`) come from the cache populated by `initUserAgentData()`. Returns `{}` on browsers without UA-CH support (Firefox, Safari).
- `parseUtmParams(search)` — extracts UTM campaign params from a query string via `URLSearchParams`. Returns only UTM params that are present in the query string with non-empty values: `$utmSource`, `$utmMedium`, `$utmCampaign`, `$utmContent`, `$utmTerm`.

### Session Tracking (`src/session.ts`)

Module-level state, no classes. Sessions are lazily initialized on the first `resolveSessionId()` call and persisted through the `PersistentStore` under a project-namespaced key (`__pug_<projectId>_session__` via `makeStorageKey`), so with cross-subdomain tracking the session (and its `deviceId`) continues across sibling subdomains. Expiry is evaluated lazily on each call — no timers. Cross-tab sync is handled by re-reading storage on every call; if another tab wrote a newer `lastActivityTime`, it is adopted automatically.

- `resolveSessionId()` — called by `pug.track()` on every event. Reads storage on every call (for cross-tab sync), rotates if expired, updates `lastActivityTime`. Persists on every event in origin-scoped mode (localStorage is cheap); in cross-subdomain mode the `lastActivityTime` write is throttled (`ACTIVITY_PERSIST_THROTTLE_MS`, 10s) so the shared cookie is not rewritten on every event — the in-memory state stays exact and session-id changes (`rotate()`/`resetIdentity()`) still persist immediately. The throttle clock (`lastPersistMs`) advances only on a persist that actually lands, so a dropped cookie write leaves it stale and is retried on the next event rather than suppressed for the window. Returns the current session ID.
- `rotate()` — generates a new uuidv7 session ID and writes it to storage immediately (logging a warning if the write does not persist). Exported for users who need to force a new session (e.g. on logout). `resetIdentity()` (session + device reset, on logout) logs an error on a failed persist, since the previous identity could otherwise resurface.
- `configureSession(projectId, config?, store?)` — called by `pug.init()`. Sets `idleTimeoutMinutes` (default 30) and `maxSessionMinutes` (default 1440) and adopts the shared `PersistentStore`.
- `destroySession()` — a runtime teardown, not a logout: removes the `pagehide` listener, drops this tab's origin-local registry entry, and resets all module state and config to defaults, but leaves the persisted session in place (in cross-subdomain mode removing the shared cookie would end sessions site-wide from one page's teardown), so a later `init()` resumes it. Called by `pug.destroy()`.
- `clearSession()` — removes the persisted session and in-memory state while leaving the module configured, so a later `resolveSessionId()` lazily starts a fresh session. Called by `optOutTracking()`; in cross-subdomain mode this clears the shared cookie, so the opt-out propagates across sibling subdomains, and logs an error if the removal cannot be confirmed (an unremoved shared cookie would otherwise resurface the identity).

If no persistence layer is usable, sessions continue in memory only. The tab registry (per-tab heartbeats driving "all tabs closed → rotate on next init") stays on raw `localStorage` and is skipped entirely when `store.crossSubdomain` is true — tab liveness is origin-local, so with a shared session an `init()` on one subdomain with no live tabs there would wrongly rotate a session still active on a sibling; in that mode sessions end by idle/max timeout only.

### Profile Identity (`src/profile.ts`)

Module-level state, no classes. Manages anonymous profile IDs persisted through the `PersistentStore` under `__pug_<projectId>_profile__` — with cross-subdomain tracking, the anonymous ID and `externalId` ride the shared cookie, so a visitor moving between sibling subdomains keeps one identity. Anonymous IDs are prefixed with `"anon-"` (required by the server for merge operations).

- `configureProfile(projectId, store?, isGranted?)` — called by `pug.init()`. Adopts the shared store, sets storage keys, and restores any persisted `externalId` from a previous `identify()` call (re-writing it to refresh a cookie-backed store's expiry — but only when `isGranted?.() ?? true`, so no identity cookie write happens while consent is denied; the restore-into-memory always happens since it only feeds the consent-gated `track()`/`identify()`).
- `getAnonymousId()` — returns or creates a persistent `"anon-<uuidv7>"` ID (restores from the store when present, refreshing its expiry).
- `resolveDistinctId()` — returns `externalId` if one has been persisted (from a previous `identify()` call, even across page loads), otherwise the anonymous ID. Called by `track()` to set the `distinctId` field on every event.
- `isIdentified()` / `markIdentified(id)` — `isIdentified()` returns `true` when `externalId` is non-empty (derived, no separate flag). `markIdentified` persists the `externalId` so it survives page reloads. Controls whether `anonymousId` is sent on the next `identify()` RPC (first call triggers server-side merge of anonymous → identified profile; subsequent calls skip merge).
- `clearProfile()` — clears storage (both anonymous ID and external ID) and resets identified state, logging an error per key whose removal cannot be confirmed (an unremoved shared cookie would otherwise resurface the identity). Called by `pug.reset()` and `optOutTracking()`.
- `destroyProfile()` — resets all module state but, like `destroySession()`, leaves persisted identity in place (a runtime teardown must not wipe the shared cross-subdomain cookie for every sibling subdomain); `clearProfile()` via `reset()` (or `clearProfile()` + `clearSession()` via `optOutTracking()`) is the deliberate clear. Called by `pug.destroy()`.

`identify(externalId, traits?)` in `pug.ts` sends the `ProfilesSDKService.Identify` RPC. On the first call, it includes `anonymousId` so the server merges the anonymous profile into the identified one. Subsequent calls send an empty `anonymousId` (trait-only updates). The profiles RPC client is lazy-created on first allowed `identify()` call. Respects tracking consent and `dryRun` mode.

### Well-Known Events (`src/well-known-events.ts` + `src/well-known-events.generated.ts`)

`src/well-known-events.generated.ts` is the `wellKnownSchemas` registry: a `const` object mapping every well-known event name string to its protobuf `*PropertiesSchema` descriptor imported from `@buf/pugsh_pug.bufbuild_es`. The file is generated by `scripts/gen-well-known-events.mjs` (run automatically by `prebuild`), which walks every `*PropertiesSchema` exported under `common/events/v1/*_events_pb.js`, reads the wire-name string from the `(common.events.v1.kind)` message option via `getExtension`, and filters by the `(common.events.v1.platforms)` option — events that explicitly target only non-WEB platforms (IOS/ANDROID/DESKTOP/SERVER) are excluded; events without a `platforms` annotation are treated as platform-neutral and included. Proto rather than the SDK is the single source of truth — when buf bumps and adds/renames/retargets events, the next `bun run build` re-emits the file with no hand-edits.

`src/well-known-events.ts` is the hand-written wrapper: re-exports `wellKnownSchemas` from the generated file and derives `WellKnownEventName` (the literal union of all well-known event names) and `WellKnownEventPropsMap` (mapping each name to its `MessageInitShape`) from `typeof wellKnownSchemas`. Also defines `TrackFn` (an overloaded function type: the first overload narrows properties for well-known events, the second accepts any `string` event with loose `Record<string, JsonValue>` props) and `TrackOptions`. Re-exports `JsonValue` from `@bufbuild/protobuf`.

### Event Creation (`src/track.ts`)

`toEvent(projectId, kind, sessionId, distinctId, props?, opts?)` builds a protobuf `Event` object from event kind, properties, and options. Each call generates a fresh `eventId` (uuidv7, required by the proto) and stamps `occurTime` with the current time (or `opts.timestamp` if finite). The `customProperties` field is a typed `map<string, common.v1.PropertyValue>` — a oneof over `string`, `int64` (TypeScript `bigint`), `double`, `bool`, and `Timestamp`. Two paths populate it:

- **Well-known events** (kinds present in `wellKnownSchemas`): `validateWellKnownProps` partitions input into known and extra keys, dropping extras with non-serializable types (`undefined`/`function`/`symbol`) with a warn log, then runs `create()` + `@bufbuild/protovalidate` on the known keys and returns `{ ok: true, msg, extras }` (or `{ ok: false }` on validation failure with a contextual error log). `buildKnownPropertyMap` then uses `reflect()` from `@bufbuild/protobuf/reflect` to honor the schema's explicit field presence — only fields where `r.isSet(field)` returns true are included, so an unset `scrollY` is skipped while an explicit `scrollY: 0` is preserved. For each set scalar, `scalarToPropertyValue` picks the oneof case from the field's proto scalar type (`field.scalar`) so that an integer-valued `double` field still serializes as `doubleValue`. Non-scalar fields and unknown scalar types (e.g. `BYTES`) log a warn instead of being silently dropped — today's well-known schemas only use scalars but the moment one doesn't, the maintainer needs a loud signal at SDK-bump time. Extras are then merged in via `jsValueToPropertyValue`.
- **Custom events**: every entry in `props` flows through `jsValueToPropertyValue`. Mapping: `string` → `stringValue` (truncated to 1024 UTF-8 bytes with a warn log if longer — proto's `string.max_len = 1024` is counted by protovalidate as code points, so byte-truncation is strictly more conservative); `boolean` → `boolValue`; finite `number` → `intValue` if `Number.isSafeInteger` else `doubleValue` (non-finite numbers dropped); `bigint` → `intValue`; `Date` → `timestampValue` via `timestampFromMs(d.getTime())` (`Date(NaN)` dropped); arrays/objects → `JSON.stringify` then string policy (circular structures and `toJSON` returning undefined dropped); `null`/`undefined` dropped silently (no warn — they're common and unactionable). Every other drop is logged at the call site with the property key for grep-ability, since `track()` itself never throws and undiagnosed drops would mask real user bugs.

Auto properties include: `$projectId`, `$url`, `$referrer`, `$locale`, `$screenWidth`, `$screenHeight`, `$pageTitle`, `$sdkVersion`, UA Client Hints when available (`$browser`, `$browserVersion`, `$os`, `$osVersion`, `$device`, `$mobile`), and any present UTM params. `sessionId` and `distinctId` are set as top-level fields on the `Event` proto (their own ClickHouse columns), not properties. `distinctId` is the profile identifier — `externalId` after `identify()`, otherwise the anonymous ID. After building the `Event` proto, `toEvent` validates the full `Event` object against `EventSchema` via protovalidate; invalid events are dropped with an error log. Re-exports `TrackFn`, `TrackOptions`, `JsonValue`, `WellKnownEventName`, and `WellKnownEventPropsMap` from `well-known-events.ts`.

### Transport Layer (`src/transport.ts`)

`createTransport(endpoint, apiKey)` returns an object with `send`, `sendBatch`, and `beacon` methods. It uses ConnectRPC with protobuf serialization via `@buf/pugsh_pug.bufbuild_es`. The `beacon` method uses `navigator.sendBeacon` with binary protobuf for reliable delivery during page unload; since `sendBeacon` cannot carry request headers, the API key is appended as a `?api_key=` query parameter on the beacon URL.

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

`autoCapture` maps to these tracker modules by key: `pageView`, `click`, `scroll`, `form`, `rageClick`, and `deadClick`.

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
- `isStorageAvailable()` — probes localStorage with a write/remove sentinel. Returns `true` if available, `false` if blocked (private mode, quota, security policy). Used by `persistence.ts`, `session.ts` (tab registry), `batch.ts`, and `push.ts`.

### Key Patterns

- Trackers receive a `track` function and call it directly — they do not access the transport. All browser event listeners are attached globally (document/window level) during `init()` and removed during `destroy()`.
- Use `const = () =>` arrow functions everywhere. The only exceptions are `function` expressions that need `this` binding (e.g., history method wrappers in `page_view.ts`).
- Events are protobuf `Event` objects created via `toEvent()`, not plain JS objects.

### Design Invariants

- **`track()` must never throw.** It is wrapped in a centralized try/catch (with defensive logging via the internal `log` module) and any transport errors are caught via `.catch()`. Because trackers call `track()` from places like monkey-patched `history.pushState`/`replaceState`, an exception would break the host application. Callers may rely on `track()` being safe to call without their own error handling.
- **`identify()` must never throw.** Like `track()`, it is wrapped in a centralized try/catch; invalid input, calls before `init()`, denied consent, `dryRun`, and RPC failures are logged and the returned promise resolves without sending. Callers may `await` it without their own error handling.

## TypeScript & Module Setup

- Target/module: ES2020, strict mode, declarations emitted to `dist/`
- Imports within `src/` use `.js` extensions (required for ES module resolution at runtime)
- Module resolution: `bundler`
- Barrel export: `src/index.ts` re-exports `init`, `destroy`, `track`, `reset`, `identify`, `setAutoCapture`, `optInTracking`, `optOutTracking`, `isTrackingEnabled`, `getTrackingConsent`, `rotate` and types `PugConfig`, `InitOptions`, `AutoCaptureSelection`, `AutoCaptureConfig`, `CrossSubdomainConfig`, `TrackingConsent`, `TrackingConsentConfig`, `BatchConfig`, `TrackOptions`, `SessionConfig`, `JsonValue`, `JsonObject`, `TrackFn`, `WellKnownEventName`, `WellKnownEventPropsMap`; and from `push.ts`: `subscribePush`, `unsubscribePush`, `setupNotificationClickTracking`, `PushOptions`. `JsonValue` and `JsonObject` are re-exported from `@bufbuild/protobuf`. Deprecated alias `PugEventName` (→ `WellKnownEventName`) is re-exported for backward compatibility. Internal module functions and implementation details are not publicly exported.
