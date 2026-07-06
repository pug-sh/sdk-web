import type { CookieLayer } from './cookie.js'
import { log } from './logger.js'
import { isStorageAvailable } from './utils.js'

/**
 * Layered key-value persistence: an optional cross-subdomain cookie layer over localStorage.
 * Reads prefer the cookie (it is the shared source of truth across subdomains — a stale per-origin
 * localStorage value must not shadow it); writes go to every available layer; methods never throw.
 */
export interface PersistentStore {
  getItem(key: string): string | null
  /**
   * Returns true when the value will be readable on the next page load. In cross-subdomain mode
   * that requires the cookie write to land (reads trust only the cookie); otherwise any layer
   * suffices.
   */
  setItem(key: string, value: string): boolean
  /**
   * Returns true when a subsequent getItem would return null — the value is gone from every layer
   * reads consult (the cookie in cross-subdomain mode; both layers otherwise). Lets opt-out/reset
   * surface a privacy teardown that did not land.
   */
  removeItem(key: string): boolean
  /** True when values are shared across subdomains via a domain-scoped cookie. */
  readonly crossSubdomain: boolean
}

/** Returns null only when no layer is usable (cookies absent and localStorage unavailable). */
export const createPersistentStore = (cookies: CookieLayer | null): PersistentStore | null => {
  const local = isStorageAvailable() ? localStorage : null
  if (!local && !cookies) {
    return null
  }
  const crossSubdomain = cookies?.crossSubdomain ?? false
  // One-time-per-key throttle so a repeatedly-failing cross-subdomain cookie write (e.g. the
  // session-state write re-attempted on activity) does not spam the console over a long session.
  const warnedKeys = new Set<string>()
  return {
    crossSubdomain,
    getItem: key => {
      if (cookies) {
        let value: string | null = null
        try {
          value = cookies.get(key)
        } catch (err) {
          log.warn(`Failed to read "${key}" from cookies:`, err)
        }
        if (value !== null) {
          return value
        }
        // In cross-subdomain mode the shared cookie is authoritative: a miss means the value was
        // never set or was deleted. Falling back to this origin's localStorage would resurrect a
        // value a sibling origin still holds — and re-broadcast it on the next write — so a
        // reset()/logout on one subdomain would not stick. Host-only / no-cookie stores are
        // origin-scoped and still fall back.
        if (crossSubdomain) {
          return null
        }
      }
      if (local) {
        try {
          return local.getItem(key)
        } catch (err) {
          log.warn(`Failed to read "${key}" from localStorage:`, err)
        }
      }
      return null
    },
    setItem: (key, value) => {
      let cookiePersisted = false
      if (cookies) {
        try {
          cookiePersisted = cookies.set(key, value)
        } catch (err) {
          log.warn(`Failed to write "${key}" to cookies:`, err)
        }
      }
      let localPersisted = false
      if (local) {
        try {
          local.setItem(key, value)
          localPersisted = true
        } catch (err) {
          log.warn(`Failed to write "${key}" to localStorage:`, err)
        }
      }
      // In cross-subdomain mode getItem never falls back to localStorage, so a localStorage-only
      // success is not persistence — report the cookie's outcome so identity/consent callers can
      // log truthfully when their write will not stick.
      const persisted = crossSubdomain ? cookiePersisted : cookiePersisted || localPersisted
      // The probe passing at init does not guarantee later writes land (cookies can be disabled or
      // dropped, quota can fill mid-session). Whenever the value will not be readable on the next
      // load — on any layer reads consult — say so once per key, in both modes. Host-only stores
      // fall back to localStorage on read, so a dropped cookie there is a loss only when localStorage
      // is also gone — which is exactly what `!persisted` captures.
      if (!persisted && !warnedKeys.has(key)) {
        warnedKeys.add(key)
        log.warn(
          crossSubdomain
            ? `Cross-subdomain cookie for "${key}" did not persist; this value will not survive a page load.`
            : `Persisting "${key}" failed on every available storage layer; this value will not survive a page load.`,
        )
      }
      return persisted
    },
    removeItem: key => {
      // Absent layers can't hold a stale value, so they default to "removed".
      let cookieRemoved = true
      if (cookies) {
        try {
          cookieRemoved = cookies.remove(key)
        } catch (err) {
          cookieRemoved = false
          log.warn(`Failed to remove "${key}" from cookies:`, err)
        }
      }
      let localRemoved = true
      if (local) {
        try {
          local.removeItem(key)
        } catch (err) {
          localRemoved = false
          log.warn(`Failed to remove "${key}" from localStorage:`, err)
        }
      }
      // A subsequent getItem returns null only when every layer it would consult is cleared: the
      // cookie is authoritative in cross-subdomain mode; otherwise reads prefer the cookie and fall
      // back to localStorage, so both must be gone.
      return crossSubdomain ? cookieRemoved : cookieRemoved && localRemoved
    },
  }
}

/**
 * Resolves the optional store argument shared by configureSession / configureProfile /
 * createTrackingConsent. `undefined` (the caller omitted it — non-init internal callers and tests)
 * builds a localStorage-only store; an explicit `null` (init() found no usable layer) means no
 * persistence; a provided store is used as-is.
 */
export const resolveStore = (provided?: PersistentStore | null): PersistentStore | null =>
  provided === undefined ? createPersistentStore(null) : provided
