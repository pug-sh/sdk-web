import { DevicesService, SubscribeRequestSchema } from '@buf/fivebits_cotton.bufbuild_es/sdk/devices/v1/devices_pb.js'
import { create } from '@bufbuild/protobuf'
import { createValidator } from '@bufbuild/protovalidate'
import { createClient } from '@connectrpc/connect'
import { createApiTransport } from './api-transport.js'
import { log } from './logger.js'
import type { JSONValue, TrackFn, WellKnownEventName } from './track.js'
import { isStorageAvailable, urlBase64ToUint8Array } from './utils.js'

const validator = createValidator()
const DEVICE_ID_KEY = 'cotton_device_id'
const DEFAULT_SW_PATH = '/cotton_sw.js'
const SW_ACTIVATE_TIMEOUT_MS = 10_000

const generateDeviceId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    log.warn('crypto.randomUUID() unavailable, using crypto.getRandomValues()')
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'))
    return [
      hex.slice(0, 4).join(''),
      hex.slice(4, 6).join(''),
      hex.slice(6, 8).join(''),
      hex.slice(8, 10).join(''),
      hex.slice(10, 16).join(''),
    ].join('-')
  }
  log.warn('crypto API unavailable, falling back to Math.random()')
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

const getOrCreateDeviceId = (): string => {
  try {
    if (isStorageAvailable()) {
      const stored = localStorage.getItem(DEVICE_ID_KEY)
      if (stored) {
        return stored
      }
      const id = generateDeviceId()
      localStorage.setItem(DEVICE_ID_KEY, id)
      return id
    }
  } catch (err) {
    log.warn('localStorage access failed for device ID, using ephemeral ID:', err)
  }
  return generateDeviceId()
}

const waitForServiceWorkerActive = (reg: ServiceWorkerRegistration): Promise<void> =>
  new Promise((resolve, reject) => {
    if (reg.active) {
      resolve()
      return
    }
    const worker = reg.installing ?? reg.waiting
    if (!worker) {
      reject(new Error('[Cotton SDK] Service worker registration has no installing, waiting, or active worker'))
      return
    }

    const timer = setTimeout(() => {
      worker.removeEventListener('statechange', onStateChange)
      reject(
        new Error(
          `[Cotton SDK] Service worker did not activate within ${SW_ACTIVATE_TIMEOUT_MS}ms (state: ${worker.state})`
        )
      )
    }, SW_ACTIVATE_TIMEOUT_MS)

    const onStateChange = () => {
      if (worker.state === 'redundant') {
        clearTimeout(timer)
        worker.removeEventListener('statechange', onStateChange)
        reject(new Error('[Cotton SDK] Service worker became redundant and will not activate'))
        return
      }
      if (reg.active) {
        clearTimeout(timer)
        worker.removeEventListener('statechange', onStateChange)
        resolve()
      }
    }

    worker.addEventListener('statechange', onStateChange)
  })

export interface PushOptions {
  readonly endpoint: string
  readonly apiKey: string
  readonly swPath?: string
  readonly profileId?: string
  readonly profileExternalId?: string
}

/**
 * Registers the browser for push notifications and subscribes the device with the backend.
 *
 * Requires `Notification.requestPermission()` to be granted before calling.
 * Throws if Web Push is unsupported, inputs are invalid, or the backend call fails.
 * Creates its own RPC transport (separate from the analytics transport created by `init()`).
 * Persists a device ID to `localStorage` under `cotton_device_id`.
 */
export const subscribePush = async (vapidPublicKey: string, options: PushOptions): Promise<void> => {
  if (!vapidPublicKey || typeof vapidPublicKey !== 'string') {
    throw new Error('[Cotton SDK] vapidPublicKey is required and must be a non-empty string')
  }
  if (!options.endpoint || typeof options.endpoint !== 'string') {
    throw new Error('[Cotton SDK] options.endpoint is required and must be a non-empty string')
  }
  if (!options.apiKey || typeof options.apiKey !== 'string') {
    throw new Error('[Cotton SDK] options.apiKey is required and must be a non-empty string')
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('[Cotton SDK] Web Push is not supported in this browser')
  }

  const swPath = options.swPath ?? DEFAULT_SW_PATH

  const reg = await navigator.serviceWorker.register(swPath)
  await waitForServiceWorkerActive(reg)

  let applicationServerKey: Uint8Array<ArrayBuffer>
  try {
    applicationServerKey = urlBase64ToUint8Array(vapidPublicKey)
  } catch (err) {
    throw new Error(`[Cotton SDK] Invalid VAPID public key (must be valid base64url): ${err}`)
  }

  const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })

  const deviceId = getOrCreateDeviceId()
  const pushToken = JSON.stringify(subscription.toJSON())

  const transport = createApiTransport(options.endpoint, options.apiKey)
  const devicesClient = createClient(DevicesService, transport)

  const request = create(SubscribeRequestSchema, {
    deviceId,
    platform: 'web',
    token: pushToken,
    profileId: options.profileId ?? '',
    profileExternalId: options.profileExternalId ?? '',
  })

  // subscribePush throws on validation failure (critical operation), unlike toEvent which
  // drops invalid events with an error log (best-effort, respecting the "track() must never throw" invariant).
  const result = validator.validate(SubscribeRequestSchema, request)
  if (result.kind !== 'valid') {
    const detail =
      result.kind === 'invalid'
        ? result.violations.map(v => `${v.field}: ${v.message}`).join(', ')
        : String(result.error)
    throw new Error(`[Cotton SDK] Invalid subscribe request: ${detail}`)
  }

  await devicesClient.subscribe(request)
}

export const eventNotificationClick = 'notification_clicked' satisfies WellKnownEventName

// Filters notification data to flat primitive values. Nested objects and arrays are dropped
// to keep notification properties simple and predictable — the payload originates from the
// push service and may contain arbitrary structures.
const sanitizeNotificationData = (raw: unknown): Record<string, JSONValue> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {}
  }
  const data: Record<string, JSONValue> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      data[k] = v
    } else if (v !== null && v !== undefined) {
      dropped.push(k)
    }
  }
  if (dropped.length > 0) {
    log.debug(`notification_clicked: dropped non-primitive properties: ${dropped.join(', ')}`)
  }
  return data
}

const trackNotificationClick = (track: TrackFn, data: Record<string, JSONValue>) => {
  const cid = data.campaignId
  const campaignId = typeof cid === 'string' && cid ? cid : '(unknown)'
  if (campaignId === '(unknown)') {
    log.debug('notification_clicked: no campaignId in notification data, using fallback')
  }
  track(eventNotificationClick, { ...data, campaignId })
}

/**
 * Sets up notification click tracking. Call once after init().
 * Handles two cases:
 * - Page was opened by the click: SW encodes data in `?cotton_nc=`, read and stripped here.
 * - Page was already open: SW sends a postMessage, captured here.
 *
 * Returns a cleanup function. Call it before destroy() or on SPA teardown.
 */
export const setupNotificationClickTracking = (track: TrackFn): (() => void) => {
  // URL path: page was opened by the notification click — data is in the URL
  if (typeof window !== 'undefined' && typeof history !== 'undefined') {
    const url = new URL(location.href)
    const param = url.searchParams.get('cotton_nc')
    if (param) {
      try {
        trackNotificationClick(track, sanitizeNotificationData(JSON.parse(param)))
      } catch (err) {
        log.warn('Malformed cotton_nc parameter:', err)
      }
      try {
        url.searchParams.delete('cotton_nc')
        history.replaceState(null, '', url.toString())
      } catch (err) {
        log.warn('Failed to strip cotton_nc parameter from URL:', err)
      }
    }
  }

  // postMessage path: page was already open — SW sends a postMessage
  if (!('serviceWorker' in navigator)) {
    log.warn('serviceWorker not available — notification click tracking via postMessage will not work')
    return () => {}
  }

  const handler = (event: MessageEvent) => {
    if (!(event.source instanceof ServiceWorker)) {
      return
    }
    if (event.data?.type === 'cotton_notification_click') {
      trackNotificationClick(track, sanitizeNotificationData(event.data.data))
    }
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}

/**
 * Unsubscribes the browser's push subscription. No-ops with a warning if no
 * registration or subscription exists. Does not remove the device from the backend.
 */
export const unsubscribePush = async (options?: Pick<PushOptions, 'swPath'>): Promise<void> => {
  if (!('serviceWorker' in navigator)) {
    log.warn('Cannot unsubscribe: serviceWorker not available')
    return
  }

  const swPath = options?.swPath ?? DEFAULT_SW_PATH
  const reg = await navigator.serviceWorker.getRegistration(swPath)
  if (!reg) {
    log.warn(`No service worker registration found at "${swPath}"`)
    return
  }

  const subscription = await reg.pushManager.getSubscription()
  if (!subscription) {
    log.warn('No active push subscription found')
    return
  }

  const success = await subscription.unsubscribe()
  if (!success) {
    throw new Error('[Cotton SDK] Browser reported push unsubscription failed')
  }
}
