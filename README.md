# Cotton Web SDK

Browser-side analytics and event tracking for Cotton. Auto-captures page views, clicks, scrolls, form interactions, and frustration signals.

## Installation

```bash
npm install cotton-web
```

## Usage

### Analytics

```ts
import { init, track, destroy } from 'cotton-web'

init('your-project-id', {
  token: 'your-api-key',
  endpoint: 'https://your-backend.example.com',
})

// Manual event
track('signup', { plan: 'pro' })

// Teardown (e.g. in SPA route cleanup)
destroy()
```

All standard events (page views, clicks, scrolls, forms, rage clicks, dead clicks) are captured automatically after `init()`.

### Init options

| Option | Type | Default | Description |
|---|---|---|---|
| `token` | `string` | — | **Required.** API key. |
| `endpoint` | `string` | `http://localhost:8080` | Backend base URL. |
| `samplingRate` | `number` | `1` | Fraction of sessions to track (0–1). |
| `batch` | `Partial<BatchConfig>` | — | Batching overrides (size, wait, storage key). |

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

#### Option A — Use the Cotton drop-in service worker

Copy `cotton_sw.js` from this package into your public root (or wherever your site is served from). It handles `install`, `activate`, `push`, and `notificationclick` out of the box.

```
cp node_modules/cotton-web/cotton_sw.js public/cotton_sw.js
```

Then pass the path when calling `subscribePush` (defaults to `/cotton_sw.js` if omitted):

```ts
await subscribePush(VAPID_PUBLIC_KEY, { swPath: '/cotton_sw.js' })
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

> **Note:** This simplified handler does not support `setupNotificationClickTracking`. For notification click tracking, use the full `cotton_sw.js` instead.

Then pass your existing service worker path to `subscribePush`:

```ts
await subscribePush(VAPID_PUBLIC_KEY, { swPath: '/my-sw.js' })
```

### API

#### `subscribePush(vapidPublicKey, options)`

Registers the browser for push notifications and sends the subscription to Cotton's `DevicesService.Subscribe` RPC.

- Registers (or reuses) the service worker at `options.swPath` (default: `/cotton_sw.js`).
- Calls `pushManager.subscribe()` with your VAPID public key.
- Generates (or retrieves) a persistent device ID stored in `localStorage` under `cotton_device_id`.
- Sends the subscription token to the backend.

**You are responsible for requesting notification permission** before calling `subscribePush`. The browser's `pushManager.subscribe()` will throw if permission has not been granted.

```ts
import { subscribePush } from 'cotton-web'

const handleEnablePush = async () => {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return

  await subscribePush('BExampleVAPIDPublicKeyBase64url...', {
    endpoint: 'https://your-backend.example.com', // same as init()
    token: 'your-api-key',                        // same as init()
    swPath: '/cotton_sw.js',                      // optional, defaults to /cotton_sw.js
    profileId: 'user-uuid',                       // optional, links push device to a known profile
    profileExternalId: 'user@example.com',        // optional
  })
}
```

| Option | Type | Description |
|---|---|---|
| `endpoint` | `string` | **Required.** Backend base URL (same value passed to `init()`). |
| `token` | `string` | **Required.** API key (same value passed to `init()`). |
| `swPath` | `string` | Path to the service worker file. Defaults to `/cotton_sw.js`. |
| `profileId` | `string` | Cotton profile UUID to associate with this device. |
| `profileExternalId` | `string` | External identifier (e.g. email) to associate with this device. |

#### `setupNotificationClickTracking(track)`

Tracks `notification_clicked` events reliably across two cases:

- **Page already open** — the service worker sends a `postMessage`; this function listens for it and calls `track`.
- **Page opened by the click** — the service worker appends `?cotton_nc=<data>` to the URL; this function reads it on load, calls `track`, then removes the param with `history.replaceState`.

Call it once after `init()`. It returns a cleanup function — pass it to `destroy()` or call it on SPA teardown.

```ts
import { init, track, destroy } from 'cotton-web'
import { setupNotificationClickTracking } from 'cotton-web'

init('your-project-id', { token: 'your-api-key' })

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
import { unsubscribePush } from 'cotton-web'

await unsubscribePush({ swPath: '/cotton_sw.js' })
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
