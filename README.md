# Pug Web SDK

Browser-side analytics and event tracking for Pug. Auto-captures page views, clicks, scrolls, form interactions, and frustration signals.

## Installation

```bash
npm install pug-web
```

## Usage

### Analytics

```ts
import { init, identify, track, destroy } from 'pug-web'

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

For consent-first flows, start with tracking consent denied. While denied, automatic listeners are not attached, and manual `track()` and `identify()` are dropped (events are not queued for later replay). Set `persist: true` to remember the user's choice across reloads in `localStorage`; otherwise consent is in-memory and you pass the initial value yourself on each `init()`.

```ts
import { init, optInTracking, optOutTracking, setAutoCapture } from 'pug-web'

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
| `endpoint` | `string` | `https://api.pug.sh` | Backend base URL. |
| `batch` | `Partial<BatchConfig>` | — | Batching overrides (size, wait, storage key). |
| `autoCapture` | `boolean \| AutoCaptureSelection` | `true` | Controls SDK-owned automatic listeners. `false` disables all automatic capture; an object enables only keys set to `true`. |
| `trackingConsent` | `'granted' \| 'denied' \| { default?, persist? }` | `'granted'` | Tracking consent. While denied, automatic listeners stay off and `track()` / `identify()` are ignored. Object form: `default` is the first-run seed; `persist: true` stores the choice in `localStorage` and restores it on the next `init()`. |

### Tracking consent API

| Function | Description |
|---|---|
| `optInTracking()` | Grants consent, applies the stored `autoCapture` selection, and allows `track()` / `identify()` to send. |
| `optOutTracking()` | Revokes consent, tears down automatic listeners, and drops future `track()` / `identify()` calls. |
| `isTrackingEnabled()` | Returns `true` when tracking consent is granted. Reflects consent only — independent of `dryRun`, which suppresses delivery without changing consent. Warns and returns `false` before `init()`. |
| `getTrackingConsent()` | Returns `'granted'` or `'denied'`. Warns and returns `'denied'` before `init()`. |
| `setAutoCapture(selection)` | Stores the desired automatic listener selection. Applies immediately when consent is granted; deferred until `optInTracking()` when denied. |

### API

#### `identify(externalId, traits?)`

Creates or updates a profile for a known user. Call it after `init()` when a visitor signs in or when you learn their stable user ID.

```ts
import { identify } from 'pug-web'

await identify('user_123', {
  email: 'user@example.com',
  name: 'Ada Lovelace',
  plan: 'pro',
})
```

- `externalId` must be a non-empty string, such as your database user ID or email.
- `traits` is an optional object of profile properties. Values should be JSON-compatible.
- On the first identify call, the SDK includes the anonymous ID so anonymous events can be merged into the identified profile.
- If push is configured, the first identify call also links the browser's push device ID to the profile.
- `identify()` returns a promise and never throws — invalid input, denied consent, dry-run, and RPC failures are logged and the call resolves without sending. Check `isTrackingEnabled()` first if you need to branch on consent.

Use `reset()` when a user signs out or switches accounts:

```ts
import { reset } from 'pug-web'

reset()
```

#### `track(event, properties?, options?)`

Sends a manual event. Custom event names are allowed:

```ts
track('upgrade_clicked', { source: 'settings' })
```

Well-known events are validated against typed property schemas:

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

These event names get typed properties and runtime validation. Extra properties are allowed and are sent as custom properties.

| Event | Properties |
|---|---|
| `page_view` | — |
| `click` | `class`, `id`, `tag`, `text`, `x`, `y` |
| `rage_click` | `clickCount` (>= 2), `element`, `x`, `y` |
| `dead_click` | `element`, `text`, `x`, `y` |
| `scroll` | `percent` (0–100), `scrollY` (>= 0) |
| `search` | `query` (required) |
| `add_to_cart` | `productId` (required), `amount` (> 0), `currency` (3-letter code, required when `amount` is set) |
| `checkout_started` | `productId` (required), `amount` (> 0), `currency` (3-letter code, required when `amount` is set) |
| `checkout_completed` | `productId` (required), `amount` (> 0), `currency` (3-letter code, required when `amount` is set) |
| `purchase` | `productId` (required), `amount` (> 0), `currency` (3-letter code, required when `amount` is set) |
| `form_start` | `formId` (required), `formName` |
| `form_submit` | `action`, `formId` (required), `formName` |
| `signup` | — |
| `login` | — |
| `logout` | — |
| `app_open` | — |
| `app_close` | — |
| `notification_received` | `campaignId` (required), `notificationType` |
| `notification_clicked` | `campaignId` (required), `notificationType` |
| `notification_dismissed` | `campaignId` (required), `notificationType` |
| `video_play` | `videoId` (required), `positionS` (>= 0) |
| `video_pause` | `videoId` (required), `positionS` (>= 0) |
| `error_occurred` | `errorCode` (required) |
| `share` | — |

---

## Web Push Notifications (optional)

Push notifications are opt-in. Import `subscribePush` / `unsubscribePush` only if you need push — users who only use analytics pay zero bundle cost.

### Prerequisites

1. A VAPID key pair — generate one with:
   ```bash
   npx web-push generate-vapid-keys
   ```
2. Your backend configured with the private VAPID key to sign push messages.
3. A service worker (see options below).

### Service worker setup

You need a service worker to receive push messages. Choose one of two approaches:

#### Option A — Use the Pug drop-in service worker

Copy `pug_sw.js` from this package into your public root (or wherever your site is served from). It handles `install`, `activate`, `push`, and `notificationclick` out of the box.

```
cp node_modules/pug-web/pug_sw.js public/pug_sw.js
```

Then pass the path when calling `subscribePush` (defaults to `/pug_sw.js` if omitted):

```ts
await subscribePush(VAPID_PUBLIC_KEY, { swPath: '/pug_sw.js' })
```

#### Option B — Add to your existing service worker

If you already have a service worker, add these event listeners to it:

```js
self.addEventListener('push', (event) => {
  const data = event.data.json()
  event.waitUntil(self.registration.showNotification(data.title, data.options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  if (event.notification.data?.url) {
    clients.openWindow(event.notification.data.url)
  }
})
```

> **Note:** This simplified handler does not support `setupNotificationClickTracking`. For notification click tracking, use the full `pug_sw.js` instead.

Then pass your existing service worker path to `subscribePush`:

```ts
await subscribePush(VAPID_PUBLIC_KEY, { swPath: '/my-sw.js' })
```

### API

#### `subscribePush(vapidPublicKey, options)`

Registers the browser for push notifications and sends the subscription to Pug's `DevicesService.Subscribe` RPC.

- Registers (or reuses) the service worker at `options.swPath` (default: `/pug_sw.js`).
- Calls `pushManager.subscribe()` with your VAPID public key.
- Generates (or retrieves) a persistent device ID stored in `localStorage` under `pug_device_id`.
- Sends the subscription token to the backend.

**You are responsible for requesting notification permission** before calling `subscribePush`. The browser's `pushManager.subscribe()` will throw if permission has not been granted.

```ts
import { subscribePush } from 'pug-web'

const handleEnablePush = async () => {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return

  await subscribePush('BExampleVAPIDPublicKeyBase64url...', {
    endpoint: 'https://your-backend.example.com', // same as init()
    apiKey: 'your-api-key',                       // same as init()
    swPath: '/pug_sw.js',                         // optional, defaults to /pug_sw.js
    profileId: 'user-uuid',                       // optional, links push device to a known profile
    profileExternalId: 'user@example.com',        // optional
  })
}
```

| Option | Type | Description |
|---|---|---|
| `endpoint` | `string` | **Required.** Backend base URL (same value passed to `init()`). |
| `apiKey` | `string` | **Required.** API key (same value passed to `init()`). |
| `swPath` | `string` | Path to the service worker file. Defaults to `/pug_sw.js`. |
| `profileId` | `string` | Pug profile UUID to associate with this device. |
| `profileExternalId` | `string` | External identifier (e.g. email) to associate with this device. |

#### `setupNotificationClickTracking(track)`

Tracks `notification_clicked` events reliably across two cases:

- **Page already open** — the service worker sends a `postMessage`; this function listens for it and calls `track`.
- **Page opened by the click** — the service worker appends `?pug_nc=<data>` to the URL; this function reads it on load, calls `track`, then removes the param with `history.replaceState`.

Call it once after `init()`. It returns a cleanup function — pass it to `destroy()` or call it on SPA teardown.

```ts
import { init, track, destroy } from 'pug-web'
import { setupNotificationClickTracking } from 'pug-web'

init('your-project-id', { apiKey: 'your-api-key' })

const cleanupPushTracking = setupNotificationClickTracking(track)

// On teardown:
// cleanupPushTracking()
// destroy()
```

The `notification_clicked` event receives whatever was set in `event.notification.data` when the notification was shown:

```json
{
  "title": "New message",
  "options": {
    "body": "You have a reply.",
    "data": {
      "url": "https://your-app.example.com/inbox",
      "campaignId": "abc123"
    }
  }
}
```

→ `track('notification_clicked', { url: '...', campaignId: 'abc123' })`

> If `campaignId` is absent or empty in the notification data, it defaults to `'(unknown)'`.

#### `unsubscribePush(options?)`

Unsubscribes the browser from push notifications. Does not remove the device from the backend — call your own backend API if you need server-side cleanup.

```ts
import { unsubscribePush } from 'pug-web'

await unsubscribePush({ swPath: '/pug_sw.js' })
```

### Notification payload format

Your backend should send push messages with this JSON body:

```json
{
  "title": "Hello!",
  "options": {
    "body": "You have a new message.",
    "icon": "/icon.png",
    "data": {
      "url": "https://your-app.example.com/inbox"
    }
  }
}
```

`options` is passed directly to [`showNotification`](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification). The `data.url` field is used by `notificationclick` to open a URL when the user taps the notification.
