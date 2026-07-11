import { log } from './logger.js'
import { type PersistentStore, resolveStore } from './persistence.js'
import { makeStorageKey } from './utils.js'

export type TrackingConsent = 'granted' | 'denied'

export interface TrackingConsentConfig {
  /** First-run seed used when nothing is persisted yet. Defaults to 'granted'. */
  readonly default?: TrackingConsent
  /** Persist opt in/out and restore any persisted value on construction (i.e. on the next init()). Defaults to false. */
  readonly persist?: boolean
}

/** Narrows an untrusted value to a valid consent state. Everything else is out-of-domain. */
const isConsent = (value: unknown): value is TrackingConsent => value === 'granted' || value === 'denied'

export const createTrackingConsent = (
  projectId: string,
  config?: TrackingConsent | TrackingConsentConfig,
  persistentStore?: PersistentStore | null,
) => {
  // The config is runtime-untrusted despite its type — the CDN one-tag install feeds it from
  // data-options JSON — so validate its shape, not just its `default` value below. A shape that is
  // neither a string nor a plain object (a primitive, an array) is out-of-domain and fails closed
  // to 'denied'. Missing config (undefined/null) is the legitimate "no preference" case.
  const raw: unknown = config
  let normalized: TrackingConsentConfig
  if (raw == null) {
    normalized = {}
  } else if (typeof raw === 'string') {
    normalized = { default: raw as TrackingConsent }
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    normalized = raw as TrackingConsentConfig
  } else {
    log.warn(`Invalid trackingConsent config ${JSON.stringify(raw)}; failing closed to 'denied'.`)
    normalized = { default: 'denied' }
  }
  const persist = normalized.persist === true
  const storageKey = makeStorageKey(projectId, 'consent')
  const store = persist ? resolveStore(persistentStore) : null

  if (persist && !store) {
    log.warn('Storage unavailable; tracking consent will not persist across page loads.')
  }

  // First-run seed, then let any valid persisted value override it. A present-but-invalid `default`
  // (e.g. a typo'd 'Denied') fails closed to 'denied'; an absent one seeds the documented 'granted'.
  const seed: unknown = normalized.default
  let status: TrackingConsent = 'granted'
  if (isConsent(seed)) {
    status = seed
  } else if (seed !== undefined) {
    log.warn(`Invalid trackingConsent default ${JSON.stringify(seed)}; failing closed to 'denied'.`)
    status = 'denied'
  }
  if (store) {
    const stored = store.getItem(storageKey)
    if (isConsent(stored)) {
      status = stored
      // Re-write so a cookie-backed store refreshes its expiry.
      store.setItem(storageKey, stored)
    } else if (stored !== null) {
      log.warn(`Stored tracking consent at "${storageKey}" is invalid, ignoring.`)
    }
  }

  const write = (value: TrackingConsent): void => {
    if (!store) {
      return
    }
    if (!store.setItem(storageKey, value)) {
      log.error('Failed to persist tracking consent to storage — opt in/out will not survive page reload.')
    }
  }

  return {
    getConsent: (): TrackingConsent => status,
    isGranted: (): boolean => status === 'granted',
    optIn: (): void => {
      status = 'granted'
      write('granted')
    },
    optOut: (): void => {
      status = 'denied'
      write('denied')
    },
  }
}

export type TrackingConsentController = ReturnType<typeof createTrackingConsent>
