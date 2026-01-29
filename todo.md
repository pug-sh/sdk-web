# Cotton Web SDK — TODO

## Transport Layer

- [ ] Replace mock `console.log` transport with real HTTP transport
- [ ] Use `navigator.sendBeacon` for page unload events
- [ ] Add event batching with configurable flush interval
- [ ] Add retry logic with exponential backoff
- [ ] Add offline buffering via `localStorage` queue
- [ ] Add request timeout handling

## Session & Identity

- [ ] Generate anonymous session ID (e.g. UUID per tab/session)
- [ ] Rotate session ID after inactivity timeout (e.g. 30min with no events)
- [ ] Generate anonymous device/user ID (persisted in `localStorage`)

## Event Naming

- [ ] Separate auto-enriched properties (`projectId`, `url`, `referrer`, `userAgent`) from user-supplied properties (e.g. top-level `context` field vs `properties`)

## SDK Lifecycle

- [ ] Add `destroy()` / `shutdown()` function to tear down listeners and flush pending events
- [ ] Restore original `history.pushState` / `replaceState` on destroy
- [ ] Support re-initialization after destroy

## Sampling & Rate Limiting

- [ ] Add configurable sampling rate (e.g. `sampleRate: 0.1` for 10%)
- [ ] Add global event rate limiting / backpressure

## Testing

- [ ] Set up test framework (Vitest)
- [ ] Unit tests for frustration detection (rage click timing, cooldown, dead click mutation logic)
- [ ] Unit tests for scroll throttle behavior
- [ ] Unit tests for form deduplication (WeakSet logic)
- [ ] Unit tests for `track()` never-throw invariant
- [ ] Unit tests for page view history patching
- [ ] Integration test with mock DOM

## Documentation

- [ ] Document CSP (Content Security Policy) compatibility
- [ ] Add integration guide (script tag, npm install, bundler usage)
- [ ] Document public API surface and configuration options
