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
    var methods = ('init track identify reset destroy setAutoCapture setTrackingConsent optInTracking ' +
      'optOutTracking isTrackingEnabled getTrackingConsent isConsentPending rotate ready').split(' ');
    methods.forEach(function (m) {
      pug[m] = function () { if (q.length < 1000) q.push([m, [].slice.call(arguments)]); };
    });
    var s = d.createElement('script');
    s.async = true;
    s.src = 'https://cdn.pugs.dev/v0.0.4/pug.min.js';
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
  src="https://cdn.pugs.dev/v0.0.4/pug.min.js"
  data-project-id="your-project-id"
  data-api-key="your-api-key"
  data-options='{"trackingConsent":{"initial":"denied","persist":true}}'
></script>
```

#### `ready(cb)` — read state after the bundle loads

Calls made through the snippet's stub before the bundle arrives are queued, and they return `undefined` instead of their real value. That matters for anything that *reads* state or awaits a promise: a getter called too early answers `undefined`, not the truth. `pug.ready(cb)` runs `cb` once the SDK is loaded — at its queue position during replay, or synchronously if the bundle is already there:

```html
<script>
  // Wrong: queued before load, so isTrackingEnabled() returns undefined and the toggle renders "off".
  renderPrivacyToggle(pug.isTrackingEnabled())

  // Right: runs once the SDK has loaded and init has replayed, when the getter can actually answer.
  pug.ready(function () {
    renderPrivacyToggle(pug.isTrackingEnabled())
  })
</script>
```

`ready()` exists only on the CDN build — under `npm install` the module is fully loaded before your code runs, so there is nothing to wait for.

Note that `ready()` fixes *when* you read, not *which* getter you want. `isTrackingEnabled()` answers "are events flowing right now"; `getTrackingConsent()` answers "what state is the SDK acting on"; `isConsentPending()` answers "has the user actually chosen yet" — that last one is the consent-banner gate. See the [API reference](#tracking-consent-api).

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

To capture only some of them, pass an `autoCapture` object. It is an **allowlist**: name the trackers you want and every other one stays off. Pass `false` to disable automatic capture entirely.

```ts
init('your-project-id', {
  apiKey: 'your-api-key',
  autoCapture: {
    pageView: true,
    click: true,
  },
})
// Captures page views and clicks. scroll, form, rageClick and deadClick stay off.
```

Because it is an allowlist rather than a denylist, there is no way to spell "everything except X". Setting a key to `false` never turns *other* trackers on: `{ scroll: false }` enables nothing at all, and `{ pageView: true, scroll: false }` enables only page views — click, form, rage click and dead click are off too. So the values are typed `true` and TypeScript rejects an explicit `false` — list what you want enabled, or pass `false` as the whole value to turn everything off deliberately.

For a value known only at runtime, write `|| undefined` so the key is omitted rather than set to `false`:

```ts
autoCapture: { pageView: true, scroll: enableScroll || undefined }
```

Plain JS and the one-tag install aren't type-checked, so the SDK also warns at runtime whenever a selection ends up enabling nothing — whether from an explicit `false`, a non-`true` value like `"true"` or `1` from a template or config store, or a misspelled key — and names what it actually enabled.

For consent-first flows, start with tracking consent `'denied'` (nothing is captured or sent) or `'cookieless'` (events flow with no identity — see [Cookieless mode](#cookieless-mode)). While denied, automatic listeners are not attached, and manual `track()` and `identify()` are dropped (events are not queued for later replay). Set `persist: true` to remember the user's choice across reloads — it is persisted like identity (through the cross-subdomain cookie when active, so an opt-out on one subdomain applies on siblings, plus `localStorage`); otherwise consent is in-memory and you pass the initial value yourself on each `init()`.

`persist: true` is recommended for consent-first flows. Once a visitor has actually made a choice, that recorded choice is what `init()` resolves — so if it is no longer `'granted'`, `init()` clears identity left over from an earlier consented visit. It clears nothing when the state came from your `initial` seed rather than from a stored choice, in either direction: adding a `'denied'` default to an existing site does not delete your existing visitors' identities, and a placeholder `'denied'` corrected by a later `optInTracking()` does not mint a new identity on every page load.

```ts
import { init, optInTracking, optOutTracking, setAutoCapture } from '@pug-sh/browser'

init('your-project-id', {
  apiKey: 'your-api-key',
  trackingConsent: { initial: 'denied', persist: true },
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
| `debug` | `boolean` | `false` | Logs internal activity (each event tracked, plus the consent-denied and `dryRun` drops) to `console.debug`. Turn it on when events aren't arriving. Warnings and errors are always logged regardless, so this can only widen what you see. See [Debugging](#debugging). |
| `dryRun` | `boolean` | `false` | Builds events as normal but never sends them. Does not change consent, or what `isTrackingEnabled()` reports. |
| `autoCapture` | `boolean \| AutoCaptureSelection` | `true` | Controls SDK-owned automatic listeners. `false` disables all automatic capture; an object is an **allowlist** enabling only the keys set to `true`, with every omitted key off. |
| `trackingConsent` | `'granted' \| 'cookieless' \| 'denied' \| TrackingConsentConfig` | `'granted'` | Initial consent. While denied, automatic listeners stay off and `track()` / `identify()` are ignored; `'cookieless'` keeps events flowing without identity. Object form: `initial` seeds the state used until the user answers, `onReject` sets what `optOutTracking()` applies (`'denied'` by default, or `'cookieless'`), `persist: true` remembers the choice across reloads, `respectGpc: true` honors the browser's [Global Privacy Control](#global-privacy-control) signal. |
| `crossSubdomainTracking` | `boolean \| { domain?: string, maxAgeDays?: number }` | `false` | **Off by default** — sharing identity across subdomains weakens browser isolation from same-origin to same-site, so it is an explicit opt-in. `false` keeps persistence origin-scoped in `localStorage`; `true` shares identity (anonymous ID, external ID, session, consent) across subdomains via a first-party cookie on the auto-discovered registrable domain, `{ domain }` pins that cookie domain explicitly, and `{ maxAgeDays }` sets the cookie lifetime (default 365). See [Cross-subdomain tracking](#cross-subdomain-tracking) for fallback behavior and the multi-tenant caveat. |
| `beforeSend` | `(event) => event \| null \| void` | — | Redact, rewrite or drop any event before it's sent — mask URLs, strip PII from properties. See [Privacy controls](#privacy-controls). |

#### Cross-subdomain tracking

With `crossSubdomainTracking: true`, identity is written to a first-party cookie on the registrable domain (e.g. `.example.com`), auto-discovered with a write-probe. It degrades to a host-only cookie on localhost and IP hosts, and to `localStorage` when cookies are blocked; cookies set from HTTPS carry `Secure`, so identity is shared only among HTTPS subdomains. Sessions end by idle/max timeout only — the "rotate when all tabs closed" heuristic is origin-scoped and is disabled in this mode.

The cookie lives 365 days by default. Pass `maxAgeDays` to hold a shorter retention ceiling — `{ maxAgeDays: 390 }` for CNIL's 13 months, `{ maxAgeDays: 180 }` to re-solicit twice a year — omitting `domain` alongside it to keep auto-discovery:

```ts
init('your-project-id', {
  apiKey: 'your-api-key',
  crossSubdomainTracking: { maxAgeDays: 180 },
})
```

Two limits: the expiry is refreshed on every write, so it runs from the visitor's **last visit** rather than from when they consented, and it bounds the cookie only — `localStorage` has no expiry, so identity there persists until `reset()`, `optOutTracking()`, or the user clears site data. Chromium caps any cookie at 400 days regardless; Safari's ITP caps script-written cookies far lower.

**Warning:** on a custom multi-tenant domain not on the [Public Suffix List](https://publicsuffix.org/) (e.g. `a.myplatform.com` and `b.myplatform.com` as separate tenants), the write-probe returns the shared `myplatform.com`, letting sibling tenants read each other's identity — pin an explicit `{ domain }` there.

### Tracking consent API

| Function | Description |
|---|---|
| `setTrackingConsent(state)` | Sets the consent state: `'granted'`, `'cookieless'`, or `'denied'`. Leaving `'granted'` deletes the stored identity (profile + session + tab registry + any queued events, including the cross-subdomain cookie); events already collected under valid consent get one final send attempt on the way out, so a withdrawal drops them from the device without discarding data the user had agreed to. Granting later starts a fresh identity on the next event — pre-consent events are never linked to it. **Returns `false`** if the change did not fully take effect: an unrecognized state (consent then fails closed to `'denied'`), a choice that could not be persisted, or an identifier that could not be removed. See [Handling a failed consent change](#handling-a-failed-consent-change). |
| `optInTracking()` | Shorthand for `setTrackingConsent('granted')`: applies the stored `autoCapture` selection and allows `track()` / `identify()` to send with a persistent identity. Returns the same boolean. |
| `optOutTracking()` | Applies the rejection state — `'denied'` by default, or whatever `trackingConsent.onReject` is set to. With the default it tears down automatic listeners and drops future `track()` / `identify()` calls entirely. Returns the same boolean. |
| `isTrackingEnabled()` | Whether events are flowing right now — `true` for both `'granted'` and `'cookieless'` (use `getTrackingConsent()` to distinguish). Independent of `dryRun`, which suppresses delivery without changing consent. Warns and returns `false` before `init()`, which is accurate: nothing is being tracked yet. |
| `getTrackingConsent()` | The state the SDK is acting on: `'granted'`, `'cookieless'`, `'denied'`, or `undefined` before `init()`. It reports `undefined` rather than `'denied'` because a persisted choice is only read from storage during `init()`. Before the user answers this is the `initial` seed, so use `isConsentPending()` — not this — to decide whether to show a banner. |
| `isConsentPending()` | Whether the user has yet to choose. `true` before `init()` and until a stored choice is restored or `setTrackingConsent()` / `optInTracking()` / `optOutTracking()` runs. This is the banner gate: a seeded `'granted'` and a chosen `'granted'` are the same value to `getTrackingConsent()`, so keying a banner on that re-prompts users who already opted in. |
| `setAutoCapture(selection)` | Stores the desired automatic listener selection. Applies immediately while tracking is active (granted or cookieless); deferred until consent allows tracking when denied. |

#### Cookieless mode

`'cookieless'` is the middle consent state: events keep flowing, but the SDK writes **no
identifiers** to the device — no session, no profile, no cross-subdomain cookie, not even
the queued event payloads — and sends no identity. The server derives a daily-rotating
anonymous id instead, so consent-rejecting visitors still appear in traffic metrics while
staying anonymous and excluded from user counts by default.

The one thing still written is the consent choice itself, and only when you opt into
`persist: true`: a record of the user's refusal, so it survives a reload and applies across
sibling subdomains. That record is a strictly-necessary preference rather than analytics
identity. With `persist: false` (the default) no value is stored — `init()` still writes and
immediately deletes a capability probe to check whether storage is usable at all.

Events themselves are unchanged. A cookieless event carries the same automatic properties as any
other: page URL and referrer, screen dimensions, locale, and user-agent client hints (plus the page
title, on `page_view` only). Only the identity fields are dropped.

**What this settles, and what it doesn't.** Nothing identifying is stored on the device, and the id
the server derives cannot be reversed into one. It is an HMAC-SHA256 over the project, the
request's IP and its user agent, keyed by a salt that rotates daily and is deleted within 48 hours.
IP and user agent are hash inputs only — never stored, never returned — so once that salt is gone
the ids cannot be linked back to either, by us or by anyone.

It does not follow that the mode needs no consent banner. Reading device characteristics — screen
dimensions, locale, client hints — is itself within scope of ePrivacy Art. 5(3) under EDPB
Guidelines 2/2023, which extends "access to information stored in terminal equipment" beyond
cookies to fingerprinting surfaces, and the derivation above runs on IP and user agent regardless
of what the SDK stores.

Whether that is exempt in your jurisdiction is yours to decide as the controller. This mode
minimizes what is collected and stored; it does not by itself establish a lawful basis, and the SDK
does not assume one on your behalf.

Set `initial` and `onReject` and cookieless covers both ends of the flow — before the user answers
and after they decline — so the banner itself never has to know the state exists:

```js
pug.init('<project-id>', {
  apiKey: '<public-api-key>',
  trackingConsent: { initial: 'cookieless', onReject: 'cookieless', persist: true },
})

if (pug.isConsentPending()) showBanner()

onAccept(() => pug.optInTracking())   // → 'granted'
onReject(() => pug.optOutTracking())  // → 'cookieless', per onReject
```

`onReject` only redirects `optOutTracking()`; `setTrackingConsent('denied')` always means literally
denied. For a CMP that separates "reject analytics cookies" from "reject everything", drive the
three states directly instead:

```js
onAcceptAll(() => pug.setTrackingConsent('granted'))
onRejectAnalyticsCookies(() => pug.setTrackingConsent('cookieless'))
onRejectAll(() => pug.setTrackingConsent('denied'))
```

Granting consent later starts a **fresh** identity — pre-consent events are never linked
to it. Revoking from `'granted'` deletes the stored identity (including the
cross-subdomain cookie). `identify()` is disabled in cookieless mode.

#### Global Privacy Control

[GPC](https://globalprivacycontrol.org/) is a browser-level "do not sell or share my data" signal, set by Brave (on by default), Firefox, DuckDuckGo and several privacy extensions. It is legally binding under CCPA/CPRA and a growing list of US state laws; under GDPR it is at most an Art. 21 objection.

Off by default. Opt in and a visitor sending the signal starts at your rejection state, with no banner needed:

```js
pug.init('<project-id>', {
  apiKey: '<public-api-key>',
  trackingConsent: { respectGpc: true, onReject: 'cookieless', persist: true },
})
```

Precedence is seed → GPC → choice made on your site. GPC overrides `initial`, since it is the user's own standing preference rather than your placeholder, but a stored choice or a later `optInTracking()` overrides GPC — a visitor who explicitly accepts on your site has made the more specific decision, and without that rule your banner would loop forever.

Pair `respectGpc` with `persist: true`, as above. Without it there is nowhere to record that acceptance: GPC re-resolves on every load, `isConsentPending()` stays `false` so your banner never shows, and an `optInTracking()` dies with the page — leaving a GPC visitor no way to accept. The SDK warns when it resolves consent from GPC with persistence off.

A GPC visitor is not `isConsentPending()`, so a banner keyed on it stays hidden, and identity left over from an earlier consented visit is cleared at `init()`. The signal is read once per `init()`.

#### Handling a failed consent change

`setTrackingConsent()`, `optInTracking()` and `optOutTracking()` return a boolean. It is `true`
when the change fully took effect, and `false` in four cases worth handling in a consent banner:

- **It was called before `init()`.** Nothing is applied — this is the one case where `false` really
  does mean "ignored", and a banner racing initialization is the likeliest way to hit it. On the
  script-tag install use `ready()` (below); with `npm`, call it after `init()`.
- **The state was not recognized.** CMPs speak their own vocabulary (`'reject'`, `'opt-out'`, a
  boolean, or `null` before the user answers). Rather than keep the previous state — which for a
  user clicking *Reject* would silently mean staying fully tracked — consent **fails closed to
  `'denied'`**, matching how `init()` already treats the same untrusted input. Map your CMP's values
  explicitly rather than relying on this.
- **The choice could not be persisted** (`persist: true` with storage full or cookies blocked). The
  state applies in memory, but the next page load falls back to the `initial` seed — so an opt-out
  can quietly become a re-consent.
- **A stored identifier could not be removed.** With `crossSubdomainTracking` this means the identity
  cookie survived on the registrable domain and will resurface. This also covers the persisted event
  queue, whose payloads carry the identity attached at collection time.

```js
// Script-tag install: wrap in ready() so the call runs against the real SDK. Before the bundle
// loads, every stub method returns `undefined` — and `!undefined` is truthy, so the bare form
// below would report a failure that never happened, with a state of `undefined`.
pug.ready(function () {
  if (!pug.setTrackingConsent(choice)) {
    // Surface it — don't assume the device is clean or that the choice will survive a reload.
    reportConsentFailure(pug.getTrackingConsent())
  }
})
```

With an `npm` install there is no queue and no stub, so the direct form is fine:

```ts
import { getTrackingConsent, setTrackingConsent } from '@pug-sh/browser'

if (!setTrackingConsent(choice)) {
  reportConsentFailure(getTrackingConsent())
}
```

Once `init()` has run, a valid state is always applied in memory — so `false` then means "applied,
but not fully durable", not "ignored". Before `init()` it does mean ignored, which is why the
script-tag form above wraps the call in `ready()`.

### Privacy controls

Three device-side controls keep PII out of captured events. All run in the browser before anything is sent, so raw values never leave the device.

#### Element text is the element's own text

The click and dead-click trackers capture the clicked element's **own** text — its direct child text nodes — never the text of everything nested inside it. A click on a card reports the card's own label, not the name, email or order total in the elements it wraps:

```html
<!-- Click the row: text is "Open", not "Open jane@example.com 4111 1111 1111 1111". -->
<div class="row">
  Open
  <span>jane@example.com</span>
  <span>4111 1111 1111 1111</span>
</div>
```

Nested text is captured only when that element is itself what the user clicked. `<textarea>` and `contenteditable` regions never report text at all, since their content is whatever the user typed — including clicks that land on an element *inside* an editable region, which is what a rich-text editor's markup produces. An explicit `contenteditable="false"` island inside one is not user input, so its own text is still captured.

#### `data-pug-no-capture` — don't capture element text

Add the `data-pug-no-capture` attribute to any element whose text should not be tracked, for cases the own-text rule doesn't already cover — the sensitive value sits directly in the clickable element. The trackers blank the captured `text` for that element and everything inside it, while still recording the structural fields (`tag`, `id`, `class`, coordinates) so the interaction is still counted.

```html
<!-- The click still counts, but "jane@example.com" is never captured. -->
<button data-pug-no-capture>Account: jane@example.com</button>

<!-- On a container, it covers every element inside. -->
<div data-pug-no-capture>
  <span>Card ending 4242</span>
  <button>Pay $49.00</button>
</div>
```

Only free text is redacted; `id` and `class` are still sent, so keep PII out of those as well.

#### `beforeSend` — redact, rewrite or drop any event

`beforeSend` receives every property the SDK is about to send, as plain JavaScript values, and returns what should actually go out:

```ts
init('your-project-id', {
  apiKey: 'your-api-key',
  beforeSend: (event) => {
    if (event.kind === 'internal_health_check') return null // drop it

    delete event.customProperties.ssn
    delete event.autoProperties.$utmContent
    event.autoProperties.$locale = 'REDACTED'
    return event
  },
})
```

`event` is `{ kind, autoProperties, customProperties }`. `kind` is read-only, and so are the two bags themselves — mutate their contents in place (assign, or `delete` to remove a property) rather than replacing a bag wholesale.

- Return the event to send it, `null` to drop it, or nothing at all if you only mutated in place.
- `autoProperties` values are always strings. `customProperties` values are whatever you passed to `track()`, so narrow with `typeof` before using one as a string.
- `$projectId`, `$platform` and `$sdkVersion` are re-asserted after your hook — the backend keys on `$projectId` and cannot re-derive the other two, so removing them has no effect.
- `sessionId` and `distinctId` are not exposed. They're top-level fields on the event, already gated by [tracking consent](#tracking-consent-api); use `cookieless` mode or `optOutTracking()` to suppress them.
- Runs synchronously on every event — keep it cheap and side-effect-free.
- **Fails closed:** if it throws or returns something malformed, the whole event is dropped rather than sent unredacted, and the SDK warns once per failure kind. When it throws, only the error's type is logged, never its message, so a hook that interpolates the value it was redacting can't re-surface it in the console.
- Not available on the one-tag install: `data-options` is JSON, which can't carry a function. Passing a non-function `beforeSend` there drops **every** event. Use the [loader snippet](#script-tag-cdn) with a queued `init` call, or the npm package.

Masking URLs is the common case. `$url` and `$referrer` are auto-properties, and a form's `action` is a custom property on `form_submit`:

```ts
const maskUrl = (url: string) => {
  if (!url) return url // '' is a referrer-less page view — resolving it would fabricate a self-referral
  const u = new URL(url, window.location.origin)
  u.pathname = u.pathname.replace(/\/orders\/\d+/, '/orders/:orderId') // mask IDs
  u.searchParams.delete('email') // strip PII params
  return u.toString()
}

init('your-project-id', {
  apiKey: 'your-api-key',
  beforeSend: (event) => {
    event.autoProperties.$url = maskUrl(event.autoProperties.$url)
    event.autoProperties.$referrer = maskUrl(event.autoProperties.$referrer)
    const action = event.customProperties.action
    if (event.kind === 'form_submit' && typeof action === 'string') {
      event.customProperties.action = maskUrl(action)
    }
    return event
  },
})
```

A runnable demo of these controls lives in [`examples/privacy/`](./examples/privacy/).

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
- `identify()` returns a promise and never throws — invalid input, denied consent, cookieless mode, dry-run, and RPC failures are logged and the call resolves without sending.
- `externalId` must not start with `cookieless-`; the server reserves that prefix for the identities it derives in cookieless mode, and rejects any batch carrying one.
- To branch on consent, check `getTrackingConsent() === 'granted'` — **not** `isTrackingEnabled()`, which is also `true` in cookieless mode, where `identify()` is disabled and resolves without doing anything.

Use `reset()` when a user signs out or switches accounts:

```ts
import { reset } from '@pug-sh/browser'

if (!reset()) {
  // The previous user's identity may still be on this device — worth surfacing on a shared machine.
}
```

It clears the stored profile, starts a fresh session and device ID, and drops any queued events
(sending them once first, since they were collected while that user was signed in) so the next
person on a shared device does not inherit them. Like `setTrackingConsent()`, it **returns `false`**
when something could not be removed — with `crossSubdomainTracking` that means an identity cookie
survived on the registrable domain, which is exactly the case a logout needs to know about.

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

### Debugging

If events aren't arriving, pass `debug: true` to `init()`. The SDK then logs every `track()` call, the drops this flag governs — denied consent and `dryRun` — and whether auto-capture ended up with any trackers active:

```ts
init('your-project-id', { apiKey: 'your-api-key', debug: true })
```

On the one-tag install, pass it through `data-options`: `data-options='{"debug":true}'`.

Two things worth knowing:

- Debug output goes to `console.debug`, which browsers file under the **Verbose** log level. It is hidden until you enable Verbose in the DevTools console's level filter — an empty console does not mean the SDK is silent.
- Warnings and errors are never gated behind this flag, so it can only widen what you see, never narrow it. A rejected batch, a bad API key, a misconfigured option, or a `track()` call made before `init()` is reported whether or not `debug` is on.

Every line the SDK logs is prefixed with `[Pug SDK]`, so filtering the console on that string isolates its output.

### Well-known events

The SDK ships a large set of **well-known event names** with typed, autocompleted properties — pass one to `track()` and your editor completes and type-checks the payload. Any other string is accepted as a custom event.

Typing is **compile-time only**: at runtime every event takes the same path and the SDK does not validate properties client-side. Extra properties beyond the typed ones are always allowed and sent as custom properties.

What the types do catch is a wrong type on a known field — `track('purchase', { amount: '49' })` is a compile error, since `amount` is a number. What they don't catch is anything only the server knows: field constraints (`amount > 0`, `currency` matching `^[A-Z]{3}$`), and required fields. Those are enforced server-side and surface as a rejected request, so the editor is your first line of defense and not your only one.

A few fields are 64-bit integers and take a `bigint` rather than a `number` — `sizeBytes` on the file, export and chat-attachment events. Write them with the `n` suffix: `track('file_uploaded', { fileId: 'f1', sizeBytes: 1024n })`. `WELL_KNOWN_EVENTS.md` marks each one `bigint`. Property values may also be `Date`, which is sent as a timestamp.

See **[WELL_KNOWN_EVENTS.md](./WELL_KNOWN_EVENTS.md)** for the full list — each event's properties, types, and server-side constraints — grouped into these domains:

[API](./WELL_KNOWN_EVENTS.md#api) · [App](./WELL_KNOWN_EVENTS.md#app) · [Auth](./WELL_KNOWN_EVENTS.md#auth) · [Billing](./WELL_KNOWN_EVENTS.md#billing) · [Chat](./WELL_KNOWN_EVENTS.md#chat) · [Commerce](./WELL_KNOWN_EVENTS.md#commerce) · [Discovery](./WELL_KNOWN_EVENTS.md#discovery) · [Error](./WELL_KNOWN_EVENTS.md#error) · [File](./WELL_KNOWN_EVENTS.md#file) · [Form](./WELL_KNOWN_EVENTS.md#form) · [Integration](./WELL_KNOWN_EVENTS.md#integration) · [Invitation](./WELL_KNOWN_EVENTS.md#invitation) · [Media](./WELL_KNOWN_EVENTS.md#media) · [Navigation](./WELL_KNOWN_EVENTS.md#navigation) · [Notification](./WELL_KNOWN_EVENTS.md#notification) · [Social](./WELL_KNOWN_EVENTS.md#social) · [Support](./WELL_KNOWN_EVENTS.md#support) · [Workspace](./WELL_KNOWN_EVENTS.md#workspace)

## Upgrading

### Unreleased — breaking changes

Three **runtime** changes affect every install, including JavaScript and one-tag:

- The `click` and `dead_click` `text` property is now the clicked element's own text rather than its whole subtree (see [Privacy controls](#privacy-controls)). Text captured from wrapper elements gets shorter and stops carrying nested content; nothing else about the events changes.
- `$pageTitle` is sent on `page_view` only, not on every event. It used to ride every click, scroll, form and frustration event; titles routinely carry names and order numbers, and the title is still joinable to later events through `sessionId`.
- **`sanitizeUrl` is removed**, replaced by [`beforeSend`](#privacy-controls), which reaches every property rather than URL fields only. TypeScript consumers get a compile error. **JavaScript and one-tag installs do not** — the option is accepted, ignored, and `$url` / `$referrer` / `form.action` start going out unmasked, so `init()` logs a warning when it sees the stale key. Migrate:

```ts
// Before
init('p', { apiKey: 'k', sanitizeUrl: maskUrl })

// After — note `action` on form_submit, which sanitizeUrl used to cover for you
init('p', {
  apiKey: 'k',
  beforeSend: (event) => {
    event.autoProperties.$url = maskUrl(event.autoProperties.$url)
    event.autoProperties.$referrer = maskUrl(event.autoProperties.$referrer)
    const action = event.customProperties.action
    if (event.kind === 'form_submit' && typeof action === 'string') {
      event.customProperties.action = maskUrl(action)
    }
    return event
  },
})
```

Two differences from `sanitizeUrl` to carry over into `maskUrl` itself. It no longer skips `''`, so a base-relative masker would resolve a referrer-less page view into a fabricated self-referral — guard with `if (!url) return url`. And `customProperties` values are typed as the caller's own, so narrow with `typeof` before treating one as a string, as above.

The rest are **compile-time** breaks for TypeScript consumers only.

| Change | What breaks | Fix |
|---|---|---|
| `autoCapture` values are `true`, not `boolean` | `{ scroll: false }` and any `boolean`-typed value | List only what you want enabled; for a runtime value write `scroll: flag \|\| undefined` |
| `track()` is one signature, not two overloads | A wrong type on a well-known field now errors instead of silently compiling | Correct the property type — the error names it |
| `getTrackingConsent()` returns `TrackingConsent \| undefined` | Code assuming a non-optional return under `strictNullChecks` | Handle `undefined`, which means "called before `init()`" |
| `TrackingConsent` has a third member, `'cookieless'` | Exhaustive `switch`es and `Record<TrackingConsent, …>` maps stop compiling | Handle `'cookieless'` — events flow without identity |
| `optOutTracking()` applies `trackingConsent.onReject` | Nothing by default (`onReject` defaults to `'denied'`) | Opt in with `onReject: 'cookieless'` to keep identity-free counts after a rejection; `setTrackingConsent('denied')` is unaffected |
| `sanitizeUrl` removed | `init(p, { sanitizeUrl })` no longer typechecks. JS/one-tag installs get no error — just a warning and raw URLs | Use `beforeSend` — see the migration above |
| `TrackingConsentConfig.default` renamed to `initial` | `init(p, { trackingConsent: { default: … } })` | Rename the key. `default` is a reserved word, so `const { default } = cfg` was a SyntaxError; `initial` destructures normally. A stale key now warns and **fails closed to `'denied'`** rather than silently seeding `'granted'` — including in `data-options` JSON, which no compiler checks |

The `track()` change also surfaced an int64 issue that the old permissive overload had been hiding: `sizeBytes` on the file, export and chat-attachment events is a `bigint`, so pass `1024n` rather than `1024`. It never encoded correctly as a plain number — the overload just made it compile.
