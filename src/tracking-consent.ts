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

export const createTrackingConsent = (
  projectId: string,
  config?: TrackingConsent | TrackingConsentConfig,
  persistentStore?: PersistentStore | null,
) => {
  const normalized: TrackingConsentConfig = typeof config === 'string' ? { default: config } : (config ?? {})
  const persist = normalized.persist ?? false
  const storageKey = makeStorageKey(projectId, 'consent')
  const store = persist ? resolveStore(persistentStore) : null

  if (persist && !store) {
    log.warn('Storage unavailable; tracking consent will not persist across page loads.')
  }

  // First-run seed, then let any valid persisted value override it.
  let status: TrackingConsent = normalized.default ?? 'granted'
  if (store) {
    const stored = store.getItem(storageKey)
    if (stored === 'granted' || stored === 'denied') {
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
