import { log } from './logger.js'
import { isStorageAvailable, makeStorageKey } from './utils.js'

export type TrackingConsent = 'granted' | 'denied'

export interface TrackingConsentConfig {
  /** First-run seed used when nothing is persisted yet. Defaults to 'granted'. */
  readonly default?: TrackingConsent
  /** Persist opt in/out to localStorage and restore any persisted value on construction (i.e. on the next init()). Defaults to false. */
  readonly persist?: boolean
}

export const createTrackingConsent = (projectId: string, config?: TrackingConsent | TrackingConsentConfig) => {
  const normalized: TrackingConsentConfig = typeof config === 'string' ? { default: config } : (config ?? {})
  const persist = normalized.persist ?? false
  const storageKey = makeStorageKey(projectId, 'consent')
  const storage = persist && isStorageAvailable() ? localStorage : null

  if (persist && !storage) {
    log.warn('Storage unavailable; tracking consent will not persist across page loads.')
  }

  // First-run seed, then let any valid persisted value override it.
  let status: TrackingConsent = normalized.default ?? 'granted'
  if (storage) {
    try {
      const stored = storage.getItem(storageKey)
      if (stored === 'granted' || stored === 'denied') {
        status = stored
      } else if (stored !== null) {
        log.warn(`Stored tracking consent "${stored}" at "${storageKey}" is invalid, ignoring.`)
      }
    } catch (err) {
      log.warn('Failed to read tracking consent from storage:', err)
    }
  }

  const write = (value: TrackingConsent): void => {
    if (!storage) {
      return
    }
    try {
      storage.setItem(storageKey, value)
    } catch (err) {
      log.error('Failed to persist tracking consent to storage — opt in/out will not survive page reload:', err)
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
