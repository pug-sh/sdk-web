# Loading Pug from a CDN (script tag)

The npm package ships a self-contained IIFE bundle at `dist/cdn/pug.min.js` that installs the SDK on `window.pug`. jsDelivr serves it straight from npm — no extra infrastructure:

```text
https://cdn.jsdelivr.net/npm/@pug-sh/browser@<version>/dist/cdn/pug.min.js
```

## Quick start: the loader snippet

Paste into `<head>`, before any code that calls `pug.*`:

```html
<script>
  !(function (w, d) {
    if (w.pug) return;
    var q = [];
    var pug = (w.pug = { _q: q, _v: 1 });
    var methods = ('init track identify reset destroy setAutoCapture optInTracking optOutTracking ' +
      'isTrackingEnabled getTrackingConsent rotate ready').split(' ');
    for (var i = 0; i < methods.length; i++) (function (m) {
      pug[m] = function () { if (q.length < 1000) q.push([m, [].slice.call(arguments)]); };
    })(methods[i]);
    var s = d.createElement('script');
    s.async = true;
    s.src = 'https://cdn.jsdelivr.net/npm/@pug-sh/browser@0.0.3/dist/cdn/pug.min.js';
    s.onerror = function () { console.warn('[Pug SDK] Failed to load ' + s.src); };
    d.head.appendChild(s);
  })(window, document);

  pug.init('your-project-id', { apiKey: 'your-api-key' });
</script>
```

The snippet creates a stub `window.pug` whose methods queue their calls, then loads the real bundle asynchronously. When the bundle arrives it replays the queue **in order** and replaces the stubs, so the same `pug.*` calls work before and after load.

Two rules:

- **Call `pug.init()` first.** The SDK drops any call made before `init()` (it logs a warning). The queue preserves your call order — it does not reorder `init` to the front.
- **Start opted out via `init`, not via a queued `optOutTracking()`.** `pug.optOutTracking()` before `init()` is dropped like every other pre-init call. Use `trackingConsent: { default: 'denied', persist: true }` (see [Consent](#consent-and-cmp-integration)).

## One-tag install (zero inline JavaScript)

If you can't or don't want to run inline scripts (e.g. a strict Content-Security-Policy), a single tag also works:

```html
<script async src="https://cdn.jsdelivr.net/npm/@pug-sh/browser@0.0.3/dist/cdn/pug.min.js"
  data-project-id="your-project-id" data-api-key="your-api-key"
  data-options='{"trackingConsent":{"default":"denied","persist":true}}'></script>
```

| Attribute | Required | Meaning |
|---|---|---|
| `data-project-id` | yes | First argument to `init()`. |
| `data-api-key` | yes | `apiKey` init option. |
| `data-endpoint` | no | `endpoint` init option (custom backend URL). |
| `data-options` | no | JSON object merged into the init options (flat attributes win on conflict). |

Limitations vs the snippet: `window.pug` does not exist until the bundle has loaded — there is no stub and no queue, so earlier scripts cannot call the SDK at all (later scripts should guard with `if (window.pug)`; if you need pre-load calls or `pug.ready()`, use the loader snippet instead), and `data-options` is JSON, so function-valued options (`sanitizeUrl`) are unavailable. Malformed `data-options` fails closed: the SDK logs an error and does **not** initialize, so a mangled consent config can never silently fall back to tracking-enabled. If a queued `init()` also exists (both install styles on one page), the queued call wins and the data attributes are ignored.

## How the queue works

- Anything queued before load returns `undefined` — including getters (`isTrackingEnabled()`, `getTrackingConsent()`) and promise-returning calls (`identify()`). Don't chain on them pre-load.
- `pug.ready(cb)` runs `cb` once the SDK is loaded: queued before load it fires at its queue position during replay; after load it runs synchronously. Read state or await promises inside it:

  ```js
  pug.ready(function () {
    if (pug.isTrackingEnabled()) {
      pug.identify('user-123').then(function () { /* profile updated */ });
    }
  });
  ```

- Queued arguments are live JavaScript values, so everything the npm API accepts works through the snippet — including `sanitizeUrl` functions and CMP callbacks.
- A call that throws during replay (e.g. `init` with a missing `apiKey`) is logged and does not break the rest of the queue.
- If the bundle never loads (blocked or offline), the stub caps the queue at 1,000 calls so a long-lived page cannot grow memory unboundedly, and the script tag's `onerror` logs a `[Pug SDK] Failed to load …` console warning — otherwise the failure is visible only in the network tab.
- After load, `window.pug.version` carries the SDK version and `window.pug.__loaded` marks the global as installed.

## Configuration

`pug.init(projectId, options)` takes exactly the same options as the npm package — see the [init options table](../README.md#init-options). `dryRun: true` is handy while integrating: events are processed but not sent.

## Consent and CMP integration

Start denied and persist the choice (survives reloads; rides the cross-subdomain cookie when that mode is on):

```js
pug.init('your-project-id', {
  apiKey: 'your-api-key',
  trackingConsent: { default: 'denied', persist: true },
});
```

Flip consent at runtime from your consent-management platform. Both calls are safe at any time after `init` is queued — before the bundle loads they queue; after, they apply immediately:

```js
// OneTrust
function OptanonWrapper() {
  var granted = OnetrustActiveGroups.indexOf('C0002') !== -1; // performance/analytics group
  granted ? pug.optInTracking() : pug.optOutTracking();
}

// Cookiebot
window.addEventListener('CookiebotOnAccept', function () {
  if (Cookiebot.consent.statistics) pug.optInTracking();
});
window.addEventListener('CookiebotOnDecline', function () {
  pug.optOutTracking();
});
```

While denied: automatic listeners stay off and `track()`/`identify()` are dropped (not queued). `optOutTracking()` also clears persisted identity, so no identifiers linger. `optInTracking()` re-applies the stored `autoCapture` selection; a fresh identity is created lazily on the next event.

## Version pinning

| URL | Behavior |
|---|---|
| `.../browser@0.0.3/dist/cdn/pug.min.js` | Exact pin. Immutable forever — jsDelivr archives every published version. The only form that supports [SRI](#subresource-integrity-sri). |
| `.../browser@1/dist/cdn/pug.min.js` | Rolling major (once 1.0 ships). Gets bug fixes automatically; cached at the edge for up to 7 days (we purge on release, so updates usually land sooner). |
| `.../browser@latest/...` | Don't. It rolls across breaking majors. |

While the SDK is pre-1.0, pin exact versions: under 0.x semver conventions, minor bumps may break, so a rolling `@0` is a trap. At 1.0 the recommended snippet will switch to `@1`.

### Subresource integrity (SRI)

With an exact pin you can lock the bytes. Each release publishes the `sha384-…` hash (also printed by `bun run build`):

```html
s.src = 'https://cdn.jsdelivr.net/npm/@pug-sh/browser@0.0.3/dist/cdn/pug.min.js';
s.integrity = 'sha384-<hash from the release notes>';
s.crossOrigin = 'anonymous';
```

SRI and auto-updating URLs are mutually exclusive: a rolling `@1` URL changes bytes on every release, so any pinned hash would break it. Pick one: auto-updates or byte-locking.

## Content-Security-Policy

- `script-src https://cdn.jsdelivr.net` — allows the bundle.
- The inline loader snippet needs a nonce (`<script nonce=…>`) or hash, or use the [one-tag install](#one-tag-install-zero-inline-javascript) to avoid inline JS entirely.
- `connect-src https://api.pugs.dev` (or your custom `endpoint`) — allows event delivery, including `navigator.sendBeacon` on page unload.

## Troubleshooting

- **"N call(s) were queued before pug.init()"** — move `pug.init(...)` to the top of your snippet, right after the loader IIFE.
- **"window.pug is already defined and is not the Pug loader stub"** — another library owns the `pug` global (commonly the [pug template engine](https://pugjs.org) runtime). The bundle refuses to overwrite it; load the conflicting library under a different name or use the npm package.
- **"Pug SDK vX is already loaded; ignoring duplicate load of vX"** — the tag is included twice (second snippet paste, GTM double-fire, SPA re-mount). Harmless: the first instance wins.
- **Google Tag Manager** — paste the snippet into a Custom HTML tag; the queue works normally. The one-tag data-attribute install does *not* work there (GTM injects scripts without `document.currentScript`), so use the snippet.
- **Ad blockers** — analytics scripts get list-blocked by URL pattern regardless of the host. Expect some fraction of traffic to be untracked; that's inherent to client-side analytics.
