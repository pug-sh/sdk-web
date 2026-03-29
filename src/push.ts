import { DevicesService, SubscribeRequestSchema } from '@buf/fivebits_cotton.bufbuild_es/devices/v1/devices_pb.js'
import { create } from '@bufbuild/protobuf'
import { createValidator } from '@bufbuild/protovalidate'
import { createClient } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-web'
import { isStorageAvailable, urlBase64ToUint8Array } from './utils.js'

const validator = createValidator()
const DEVICE_ID_KEY = 'cotton_device_id'
const DEFAULT_SW_PATH = '/cotton_sw.js'
const SW_ACTIVATE_TIMEOUT_MS = 10_000

const generateDeviceId = (): string => {
  try {
    return crypto.randomUUID()
  } catch (err) {
    console.warn('[Cotton SDK] crypto.randomUUID() unavailable, falling back to Math.random():', err)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    })
  }
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
    console.warn('[Cotton SDK] localStorage access failed for device ID, using ephemeral ID:', err)
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
  readonly token: string
  readonly swPath?: string
  readonly profileId?: string
  readonly profileExternalId?: string
}

export const subscribePush = async (vapidPublicKey: string, options: PushOptions): Promise<void> => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('[Cotton SDK] Web Push is not supported in this browser')
  }

  const swPath = options.swPath ?? DEFAULT_SW_PATH

  const reg = await navigator.serviceWorker.register(swPath)
  await waitForServiceWorkerActive(reg)

  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey)
  const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })

  const deviceId = getOrCreateDeviceId()
  const pushToken = JSON.stringify(subscription.toJSON())

  const transport = createConnectTransport({
    baseUrl: options.endpoint,
    useBinaryFormat: true,
    interceptors: [
      next => async req => {
        req.header.set('x-api-key', options.token)
        return next(req)
      },
    ],
  })

  const devicesClient = createClient(DevicesService, transport)

  const request = create(SubscribeRequestSchema, {
    deviceId,
    platform: 'web',
    token: pushToken,
    profileId: options.profileId ?? '',
    profileExternalId: options.profileExternalId ?? '',
  })

  const result = validator.validate(SubscribeRequestSchema, request)
  if (result.kind === 'invalid') {
    throw new Error(
      `[Cotton SDK] Invalid subscribe request: ${result.violations.map(v => `${v.field}: ${v.message}`).join(', ')}`
    )
  }

  await devicesClient.subscribe(request)
}

/**
 * Sets up notification click tracking. Call once after init().
 * Handles two cases:
 * - Page was already open: SW sends a postMessage, captured here.
 * - Page was opened by the click: SW encodes data in `?cotton_nc=`, read and stripped here.
 *
 * Returns a cleanup function (pass to destroy() or call on SPA teardown).
 */
export const setupNotificationClickTracking = (
  track: (kind: string, props?: Record<string, unknown>) => void
): (() => void) => {
  // Case 1: page was opened by the notification click — data is in the URL
  if (typeof window !== 'undefined' && typeof history !== 'undefined') {
    const url = new URL(location.href)
    const param = url.searchParams.get('cotton_nc')
    if (param) {
      try {
        const raw = JSON.parse(param)
        if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
          const data: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(raw)) {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              data[k] = v
            }
          }
          track('notification_click', data)
        }
      } catch (err) {
        console.warn('[Cotton SDK] Malformed cotton_nc parameter:', err)
      }
      url.searchParams.delete('cotton_nc')
      history.replaceState(null, '', url.toString())
    }
  }

  // Case 2: page was already open — SW sends a postMessage
  if (!('serviceWorker' in navigator)) {
    return () => {}
  }

  const handler = (event: MessageEvent) => {
    if (!(event.source instanceof ServiceWorker)) {
      return
    }
    if (event.data?.type === 'cotton_notification_click') {
      track('notification_click', (event.data.data as Record<string, unknown>) ?? {})
    }
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}

export const unsubscribePush = async (options?: { swPath?: string }): Promise<void> => {
  if (!('serviceWorker' in navigator)) {
    console.warn('[Cotton SDK] Cannot unsubscribe: serviceWorker not available')
    return
  }

  const swPath = options?.swPath ?? DEFAULT_SW_PATH
  const reg = await navigator.serviceWorker.getRegistration(swPath)
  if (!reg) {
    console.warn(`[Cotton SDK] No service worker registration found at "${swPath}"`)
    return
  }

  const subscription = await reg.pushManager.getSubscription()
  if (!subscription) {
    console.warn('[Cotton SDK] No active push subscription found')
    return
  }

  await subscription.unsubscribe()
}
