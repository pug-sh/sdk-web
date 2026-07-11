# Pug Web SDK

Browser-side analytics and event tracking for Pug. Auto-captures page views, clicks, scrolls, form interactions, and frustration signals.

## Installation

```bash
npm install @pug-sh/browser
```

### Script tag (CDN)

<details>
<summary>Loader snippet and one-tag install</summary>

No bundler? Load the SDK from the Pug CDN (`cdn.pugs.dev`) with the loader snippet — paste it into `<head>`. It fetches a single self-contained file (the whole SDK in one request), and exposes the full npm API on `window.pug`. Calls made before the script loads are queued and replayed in order after it arrives; calls queued before the first `init` are dropped:

```html
<script>
  !(function (w, d) {
    if (w.pug) { if (!w.pug._q) console.warn('[Pug SDK] window.pug already defined by another script; not loaded.'); return; }
    var q = [];
    var pug = (w.pug = { _q: q, _v: 1 });
    var methods = ('init track identify reset destroy setAutoCapture optInTracking optOutTracking ' +
      'isTrackingEnabled getTrackingConsent rotate ready').split(' ');
    methods.forEach(function (m) {
      pug[m] = function () { if (q.length < 1000) q.push([m, [].slice.call(arguments)]); };
    });
    var s = d.createElement('script');
    s.async = true;
    s.src = 'https://cdn.pugs.dev/v0.0.3/pug.min.js';
    s.onerror = function () { console.warn('[Pug SDK] Failed to load ' + s.src); };
    d.head.appendChild(s);
  })(window, document);

  pug.init('your-project-id', { apiKey: 'your-api-key' });
</script>
```

Always call `pug.init()` first in the snippet — the SDK drops calls made before init. To keep the page free of inline JavaScript (e.g. under a strict CSP), use the one-tag install instead:

```html
<script
  async
  src="https://cdn.pugs.dev/v0.0.3/pug.min.js"
  data-project-id="your-project-id"
  data-api-key="your-api-key"
  data-options='{"trackingConsent":{"default":"denied","persist":true}}'
></script>
```

</details>

## Usage

### Analytics

```ts
import { init, identify, track, destroy } from '@pug-sh/browser'

init('your-project-id', {
  apiKey: 'your-api-key',
})

// Identify a signed-in user
await identify('user@example.com', {
  name: 'Ada Lovelace',
  plan: 'pro',
})

// Manual event
track('signup', { plan: 'pro' })

// Teardown (e.g. in SPA route cleanup)
destroy()
```

All standard events (page views, clicks, scrolls, forms, rage clicks, dead clicks) are captured automatically after `init()`.

To selectively enable only some automatically captured events, use `autoCapture`. Object mode is an allowlist: omitted keys are disabled.

```ts
init('your-project-id', {
  apiKey: 'your-api-key',
  autoCapture: {
    pageView: true,
    click: true,
    scroll: false,
  },
})
```

For consent-first flows, start with tracking consent denied. While denied, automatic listeners are not attached, and manual `track()` and `identify()` are dropped (events are not queued for later replay). Set `persist: true` to remember the user's choice across reloads — it is persisted like identity (through the cross-subdomain cookie when active, so an opt-out on one subdomain applies on siblings, plus `localStorage`); otherwise consent is in-memory and you pass the initial value yourself on each `init()`.

```ts
import { init, optInTracking, optOutTracking, setAutoCapture } from '@pug-sh/browser'

init('your-project-id', {
  apiKey: 'your-api-key',
  trackingConsent: { default: 'denied', persist: true },
  autoCapture: { pageView: true, click: true },
})

// After consent is granted, stored autoCapture selection is applied:
optInTracking()

// To change automatic listeners while opted in:
setAutoCapture({ pageView: true, click: true })

// If consent is revoked, listeners are torn down automatically:
optOutTracking()
```

### Init options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | — | **Required.** API key. |
| `endpoint` | `string` | `https://api.pugs.dev` | Backend base URL. |
| `batch` | `Partial<BatchConfig>` | — | Batching overrides (size, wait, storage key). |
| `autoCapture` | `boolean \| AutoCaptureSelection` | `true` | Controls SDK-owned automatic listeners. `false` disables all automatic capture; an object enables only keys set to `true`. |
| `trackingConsent` | `'granted' \| 'denied' \| TrackingConsentConfig` | `'granted'` | Initial consent. While denied, automatic listeners stay off and `track()` / `identify()` are ignored. Object form: `default` seeds the first run; `persist: true` remembers the choice across reloads. |
| `crossSubdomainTracking` | `boolean \| { domain: string }` | `false` | **Off by default** — sharing identity across subdomains weakens browser isolation from same-origin to same-site, so it is an explicit opt-in. `false` keeps persistence origin-scoped in `localStorage`; `true` shares identity (anonymous ID, external ID, session, consent) across subdomains via a first-party cookie on the auto-discovered registrable domain, and `{ domain }` pins that cookie domain explicitly. See [Cross-subdomain tracking](#cross-subdomain-tracking) for fallback behavior and the multi-tenant caveat. |
| `sanitizeUrl` | `(url: string) => string` | — | Rewrites outgoing URLs (`$url`, `$referrer`, form actions) before they're sent — e.g. to mask IDs or strip PII. See [Privacy controls](#privacy-controls). |

#### Cross-subdomain tracking

With `crossSubdomainTracking: true`, identity is written to a first-party cookie on the registrable domain (e.g. `.example.com`), auto-discovered with a write-probe. It degrades to a host-only cookie on localhost and IP hosts, and to `localStorage` when cookies are blocked; cookies set from HTTPS carry `Secure`, so identity is shared only among HTTPS subdomains. Sessions end by idle/max timeout only — the "rotate when all tabs closed" heuristic is origin-scoped and is disabled in this mode.

**Warning:** on a custom multi-tenant domain not on the [Public Suffix List](https://publicsuffix.org/) (e.g. `a.myplatform.com` and `b.myplatform.com` as separate tenants), the write-probe returns the shared `myplatform.com`, letting sibling tenants read each other's identity — pin an explicit `{ domain }` there.

### Tracking consent API

| Function | Description |
|---|---|
| `optInTracking()` | Grants consent, applies the stored `autoCapture` selection, and allows `track()` / `identify()` to send. |
| `optOutTracking()` | Revokes consent, tears down automatic listeners, and drops future `track()` / `identify()` calls. |
| `isTrackingEnabled()` | Returns `true` when tracking consent is granted. Reflects consent only — independent of `dryRun`, which suppresses delivery without changing consent. Warns and returns `false` before `init()`. |
| `getTrackingConsent()` | Returns `'granted'` or `'denied'`. Warns and returns `'denied'` before `init()`. |
| `setAutoCapture(selection)` | Stores the desired automatic listener selection. Applies immediately when consent is granted; deferred until `optInTracking()` when denied. |

### Privacy controls

Two device-side controls keep PII out of captured events. Both run in the browser before anything is sent, so raw values never leave the device.

#### `data-pug-no-capture` — don't capture element text

Add the `data-pug-no-capture` attribute to any element whose text should not be tracked. The click and dead-click trackers blank the captured `text` for that element and everything inside it, while still recording the structural fields (`tag`, `id`, `class`, coordinates) so the interaction is still counted.

```html
<!-- The click still counts, but "jane@example.com" is never captured. -->
<button data-pug-no-capture>Account: jane@example.com</button>

<!-- On a container, it covers every element inside. -->
<div data-pug-no-capture>
  <span>Card ending 4242</span>
  <button>Pay $49.00</button>
</div>
```

Put the attribute on an **ancestor of every element that can be clicked** — a marker on a sensitive leaf won't protect it if a surrounding element is the click target. Only free text is redacted; `id` and `class` are still sent, so keep PII out of those as well.

#### `sanitizeUrl` — mask routes and strip PII from URLs

Pass a `sanitizeUrl` function to `init()` to rewrite `$url`, `$referrer`, and captured form actions before they are sent. The SDK can't know your routes, so the rules live in your app:

```ts
init('your-project-id', {
  apiKey: 'your-api-key',
  sanitizeUrl: (url) => {
    const u = new URL(url, window.location.origin)
    u.pathname = u.pathname.replace(/\/orders\/\d+/, '/orders/:orderId') // mask IDs
    u.searchParams.delete('email') // strip PII params
    return u.toString()
  },
})
```

- Runs synchronously on every event — keep it cheap and side-effect-free.
- **Fails closed:** if it throws or returns a non-string, the URL is dropped to an empty string rather than sent raw, so a bug in your sanitizer can't leak the PII it was meant to strip.
- Covers URL fields only. `$utm*` params are parsed from the raw query string separately, so don't put PII in UTM parameters.

A runnable demo of both controls lives in [`examples/privacy/`](./examples/privacy/).

### API

#### `identify(externalId, traits?)`

Creates or updates a profile for a known user. Call it after `init()` when a visitor signs in or when you learn their stable user ID.

```ts
import { identify } from '@pug-sh/browser'

await identify('user_123', {
  email: 'user@example.com',
  name: 'Ada Lovelace',
  plan: 'pro',
})
```

- `externalId` must be a non-empty string, such as your database user ID or email.
- `traits` is an optional object of profile properties. Values should be JSON-compatible.
- On the first identify call, the SDK includes the anonymous ID so anonymous events can be merged into the identified profile.
- `identify()` returns a promise and never throws — invalid input, denied consent, dry-run, and RPC failures are logged and the call resolves without sending. Check `isTrackingEnabled()` first if you need to branch on consent.

Use `reset()` when a user signs out or switches accounts:

```ts
import { reset } from '@pug-sh/browser'

reset()
```

#### `track(event, properties?, options?)`

Sends a manual event. Custom event names are allowed:

```ts
track('upgrade_clicked', { source: 'settings' })
```

Well-known event names get typed, autocompleted properties:

```ts
track('purchase', {
  productId: 'sku_123',
  amount: 49,
  currency: 'USD',
})
```

Pass `{ immediate: true }` to bypass batching for priority events, or `{ timestamp }` to set an explicit epoch-millisecond occurrence time:

```ts
track('error_occurred', { errorCode: 'PAYMENT_FAILED' }, { immediate: true })
```

### Well-known events

The SDK ships a large set of **well-known event names** with typed, autocompleted properties — pass one to `track()` and your editor completes and type-checks the payload. Any other string is accepted as a custom event.

Typing is **compile-time only**: at runtime every event takes the same path and the SDK does not validate properties client-side (field constraints are enforced server-side). Extra properties beyond the typed ones are always allowed and sent as custom properties.

See **[WELL_KNOWN_EVENTS.md](./WELL_KNOWN_EVENTS.md)** for the full list — each event's properties, types, and server-side constraints — grouped into these domains:

[API](./WELL_KNOWN_EVENTS.md#api) · [App](./WELL_KNOWN_EVENTS.md#app) · [Auth](./WELL_KNOWN_EVENTS.md#auth) · [Billing](./WELL_KNOWN_EVENTS.md#billing) · [Chat](./WELL_KNOWN_EVENTS.md#chat) · [Commerce](./WELL_KNOWN_EVENTS.md#commerce) · [Discovery](./WELL_KNOWN_EVENTS.md#discovery) · [Error](./WELL_KNOWN_EVENTS.md#error) · [File](./WELL_KNOWN_EVENTS.md#file) · [Form](./WELL_KNOWN_EVENTS.md#form) · [Integration](./WELL_KNOWN_EVENTS.md#integration) · [Invitation](./WELL_KNOWN_EVENTS.md#invitation) · [Media](./WELL_KNOWN_EVENTS.md#media) · [Navigation](./WELL_KNOWN_EVENTS.md#navigation) · [Notification](./WELL_KNOWN_EVENTS.md#notification) · [Social](./WELL_KNOWN_EVENTS.md#social) · [Support](./WELL_KNOWN_EVENTS.md#support) · [Workspace](./WELL_KNOWN_EVENTS.md#workspace)
