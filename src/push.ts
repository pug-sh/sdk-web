import { DevicesService, SubscribeRequestSchema } from '@buf/fivebits_cotton.bufbuild_es/devices/v1/devices_pb.js'
import { create } from '@bufbuild/protobuf'
import { createClient } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-web'
import { isStorageAvailable, urlBase64ToUint8Array } from './utils.js'

const DEVICE_ID_KEY = 'cotton_device_id'
const DEFAULT_SW_PATH = '/cotton_sw.js'

const generateDeviceId = (): string => {
  try {
    return crypto.randomUUID()
  } catch {
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
      if (stored) return stored
      const id = generateDeviceId()
      localStorage.setItem(DEVICE_ID_KEY, id)
      return id
    }
  } catch {
    // fall through to ephemeral id
  }
  return generateDeviceId()
}

const waitForServiceWorkerActive = (reg: ServiceWorkerRegistration): Promise<void> =>
  new Promise(resolve => {
    if (reg.active) {
      resolve()
      return
    }
    const worker = reg.installing ?? reg.waiting
    if (!worker) {
      resolve()
      return
    }
    worker.addEventListener('statechange', function onStateChange() {
      if (reg.active) {
        worker.removeEventListener('statechange', onStateChange)
        resolve()
      }
    })
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
        const data = JSON.parse(param) as Record<string, unknown>
        track('notification_click', data)
      } catch {
        // ignore malformed param
      }
      url.searchParams.delete('cotton_nc')
      history.replaceState(null, '', url.toString())
    }
  }

  // Case 2: page was already open — SW sends a postMessage
  if (!('serviceWorker' in navigator)) return () => {}

  const handler = (event: MessageEvent) => {
    if (event.data?.type === 'cotton_notification_click') {
      track('notification_click', (event.data.data as Record<string, unknown>) ?? {})
    }
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}

export const unsubscribePush = async (options?: { swPath?: string }): Promise<void> => {
  if (!('serviceWorker' in navigator)) return

  const swPath = options?.swPath ?? DEFAULT_SW_PATH
  const reg = await navigator.serviceWorker.getRegistration(swPath)
  if (!reg) return

  const subscription = await reg.pushManager.getSubscription()
  if (subscription) {
    await subscription.unsubscribe()
  }
}
