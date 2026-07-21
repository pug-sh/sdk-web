import { log } from './logger.js'
import { type PersistentStore, resolveStore } from './persistence.js'
import { makeStorageKey } from './utils.js'

export type TrackingConsent = 'granted' | 'denied' | 'cookieless'

export interface TrackingConsentConfig {
  /** First-run seed used when nothing is persisted yet. Defaults to 'granted'. */
  readonly default?: TrackingConsent
  /** Persist opt in/out and restore any persisted value on construction (i.e. on the next init()). Defaults to false. */
  readonly persist?: boolean
}

/** Narrows an untrusted value to a valid consent state. Everything else is out-of-domain. */
const isConsent = (value: unknown): value is TrackingConsent =>
  value === 'granted' || value === 'denied' || value === 'cookieless'

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
  // Whether `status` came from storage (a choice the user actually made and we recorded) rather
  // than from the config seed. Only an explicit set() ever writes, so with `persist: true` and
  // nothing stored yet, `status` is still the integrator's seed — see isAuthoritative().
  let restoredFromStorage = false
  if (store) {
    const stored = store.getItem(storageKey)
    if (isConsent(stored)) {
      status = stored
      restoredFromStorage = true
      // Re-write so a cookie-backed store refreshes its expiry.
      store.setItem(storageKey, stored)
    } else if (stored !== null) {
      log.warn(`Stored tracking consent at "${storageKey}" is invalid, ignoring.`)
    }
  }

  // Reports whether `value` will still be readable on the next page load. When persistence was never
  // requested there is nothing to fail, so in-memory consent is a success. When it *was* requested but
  // is unavailable, every write is a durability failure — the constructor warned once, but callers
  // asking "did the opt-out stick?" need the per-call answer too.
  const write = (value: TrackingConsent): boolean => {
    if (!persist) {
      return true
    }
    if (!store || !store.setItem(storageKey, value)) {
      log.error('Failed to persist tracking consent to storage — opt in/out will not survive page reload.')
      return false
    }
    return true
  }

  /**
   * Applies a consent state. Returns false when the state did not fully take effect — either the
   * value was out-of-domain (state is then forced to 'denied') or it could not be persisted. The
   * requested state is always applied in memory when valid, so false never means "nothing happened".
   */
  const set = (value: TrackingConsent): boolean => {
    if (!isConsent(value)) {
      // Fail closed, matching the init-time posture above (:36, :54) rather than keeping the previous
      // state: a caller trying to *change* consent has demonstrably lost track of it, and keeping a
      // possibly-'granted' state means a user who clicked Reject stays fully tracked. Error rather
      // than warn — this both rejects the caller's value and changes state, and the CDN global feeds
      // this path untyped values ('reject', 'cookieLess', null) straight from a CMP.
      log.error(`Invalid tracking consent state ${JSON.stringify(value)}; failing closed to 'denied'.`)
      status = 'denied'
      write('denied')
      return false
    }
    status = value
    return write(value)
  }

  return {
    getConsent: (): TrackingConsent => status,
    /**
     * Whether the resolved state is a durable record of the user's own choice rather than the
     * integrator's pre-banner placeholder — the gate on init()'s identity purge.
     *
     * Requires BOTH that persistence is on and that the value actually came back from storage.
     * `persist` alone is not enough, and reading it that way is a data-loss bug: nothing is written
     * until an explicit set(), so on a site that adds `{ default: 'denied', persist: true }` to an
     * existing deployment, every returning visitor's first load finds an empty consent key, falls
     * back to the seed, and would purge identity those users never asked to have deleted.
     *
     * With `persist: false` the initial value is whatever the caller passed on this load, which for
     * an async CMP is typically a placeholder 'denied' that a later optInTracking() corrects.
     * Purging on that would destroy a returning visitor's identity on every single page load.
     */
    isAuthoritative: (): boolean => persist && restoredFromStorage,
    /** True only for full consent — gates identity-storage writes, NOT event flow. */
    isGranted: (): boolean => status === 'granted',
    /**
     * True when events flow at all (granted or cookieless). Gates automatic listener attachment
     * (auto-capture) and answers the public isTrackingEnabled().
     *
     * It does NOT gate track() or identify(), which make their own, deliberately different checks:
     * identify() requires isGranted() (cookieless has no identity to attach traits to), and track()
     * branches on getConsent() directly, since it needs all three states — 'denied' drops, and
     * 'cookieless' takes the identity-free path rather than merely being allowed through.
     */
    isTracking: (): boolean => status === 'granted' || status === 'cookieless',
    set,
    optIn: (): boolean => set('granted'),
    optOut: (): boolean => set('denied'),
  }
}

export type TrackingConsentController = ReturnType<typeof createTrackingConsent>
