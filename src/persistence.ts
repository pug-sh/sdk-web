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
  removeItem(key: string): void
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
  // One-time-per-key throttle so a cookie write that keeps failing (e.g. session state written on
  // every event) does not spam the console.
  const warnedKeys = new Set<string>()
  return {
    crossSubdomain,
    getItem: key => {
      if (cookies) {
        const value = cookies.get(key)
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
      const cookiePersisted = cookies ? cookies.set(key, value) : false
      // The probe passing at init does not guarantee later writes land (cookies can be disabled
      // or dropped mid-session). In cross-subdomain mode the cookie is the layer reads trust, so
      // a dropped write means the value will not survive a page load — say so, once per key.
      if (cookies && !cookiePersisted && crossSubdomain && !warnedKeys.has(key)) {
        warnedKeys.add(key)
        log.warn(`Cross-subdomain cookie for "${key}" did not persist; this value will not survive a page load.`)
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
      return crossSubdomain ? cookiePersisted : cookiePersisted || localPersisted
    },
    removeItem: key => {
      cookies?.remove(key)
      if (local) {
        try {
          local.removeItem(key)
        } catch (err) {
          log.warn(`Failed to remove "${key}" from localStorage:`, err)
        }
      }
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
