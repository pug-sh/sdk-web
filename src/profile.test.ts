import { CookieJar, JSDOM } from 'jsdom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeStorageKey } from './utils.js'

const logSpies = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

vi.mock('./logger.js', () => ({ log: logSpies }))

const PROJECT_ID = 'proj'
const PROFILE_KEY = makeStorageKey(PROJECT_ID, 'profile')
const EXTERNAL_ID_KEY = makeStorageKey(PROJECT_ID, 'external_id')

// Simulates one page load: a fresh profile module instance (module state evaporates on real
// navigations) wired to a real cookie layer at `url`. Documents built over a shared CookieJar see
// each other's domain-scoped cookies exactly like subdomains of one site do; the test controls
// localStorage separately since real origins do not share it.
const pageLoad = async (url: string, jar: CookieJar) => {
  vi.resetModules()
  const [profile, { createCookieLayer }, { createPersistentStore }] = await Promise.all([
    import('./profile.js'),
    import('./cookie.js'),
    import('./persistence.js'),
  ])
  const doc = new JSDOM('', { url, cookieJar: jar }).window.document
  const store = createPersistentStore(createCookieLayer(true, doc))
  profile.configureProfile(PROJECT_ID, store)
  return { profile, store }
}

// Real origins have separate localStorage; jsdom gives us one. Snapshot/restore lets a test model
// per-origin localStorage explicitly (what `app` holds vs. what `www` holds).
const snapshotLocal = (): Record<string, string> => {
  const snap: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k) snap[k] = localStorage.getItem(k) ?? ''
  }
  return snap
}
const restoreLocal = (snap: Record<string, string>): void => {
  localStorage.clear()
  for (const [k, v] of Object.entries(snap)) localStorage.setItem(k, v)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('cross-subdomain identity', () => {
  it('keeps the anonymous ID when the user moves to a sibling subdomain', async () => {
    const jar = new CookieJar()

    const first = await pageLoad('https://app.example.com/', jar)
    const anonId = first.profile.getAnonymousId()
    expect(anonId.startsWith('anon-')).toBe(true)
    expect(localStorage.getItem(PROFILE_KEY)).toBe(anonId)

    // New origin: empty localStorage, but the shared cookie survives.
    localStorage.clear()
    const second = await pageLoad('https://www.example.com/', jar)
    expect(second.profile.getAnonymousId()).toBe(anonId)
    // Restore also backfills the new origin's localStorage (and refreshes the cookie's expiry).
    expect(localStorage.getItem(PROFILE_KEY)).toBe(anonId)
  })

  it('keeps the identified external ID when the user moves to a sibling subdomain', async () => {
    const jar = new CookieJar()

    const first = await pageLoad('https://app.example.com/', jar)
    first.profile.markIdentified('user-42')

    localStorage.clear()
    const second = await pageLoad('https://www.example.com/', jar)
    expect(second.profile.isIdentified()).toBe(true)
    expect(second.profile.resolveDistinctId()).toBe('user-42')
    expect(localStorage.getItem(EXTERNAL_ID_KEY)).toBe('user-42')
  })

  it('prefers the shared cookie over a conflicting localStorage value', async () => {
    const jar = new CookieJar()

    const first = await pageLoad('https://app.example.com/', jar)
    const anonId = first.profile.getAnonymousId()

    // This origin has a stale identity in localStorage; the shared cookie must win.
    localStorage.clear()
    localStorage.setItem(PROFILE_KEY, 'anon-stale-local')
    const second = await pageLoad('https://www.example.com/', jar)
    expect(second.profile.getAnonymousId()).toBe(anonId)
  })

  it('stores the anonymous ID in the cookie layer, not just localStorage', async () => {
    const jar = new CookieJar()
    const { profile, store } = await pageLoad('https://app.example.com/', jar)
    const anonId = profile.getAnonymousId()
    localStorage.removeItem(PROFILE_KEY)
    expect(store?.getItem(PROFILE_KEY)).toBe(anonId)
  })

  it('generates distinct IDs per origin when cross-subdomain tracking is off', async () => {
    vi.resetModules()
    const load = async () => {
      vi.resetModules()
      const profile = await import('./profile.js')
      const { createPersistentStore } = await import('./persistence.js')
      profile.configureProfile(PROJECT_ID, createPersistentStore(null))
      return profile
    }

    const first = await load()
    const id1 = first.getAnonymousId()
    localStorage.clear()
    const second = await load()
    expect(second.getAnonymousId()).not.toBe(id1)
  })

  it('clears the shared cookie on clearProfile so siblings get a fresh identity', async () => {
    const jar = new CookieJar()

    const first = await pageLoad('https://app.example.com/', jar)
    const anonId = first.profile.getAnonymousId()
    first.profile.clearProfile()

    localStorage.clear()
    const second = await pageLoad('https://www.example.com/', jar)
    expect(second.profile.getAnonymousId()).not.toBe(anonId)
  })

  it('logs an error when clearProfile cannot confirm the identity was removed', async () => {
    vi.resetModules()
    const profile = await import('./profile.js')
    // A store whose removals never land (e.g. the shared cookie blocked mid-session): clearProfile
    // must surface it, since an unremoved identity cookie would resurface on the next read.
    const store = { crossSubdomain: true, getItem: () => null, setItem: () => true, removeItem: () => false }
    profile.configureProfile(PROJECT_ID, store)
    profile.clearProfile()
    expect(logSpies.error).toHaveBeenCalledWith(
      'Failed to clear the anonymous profile from storage — it may resurface on the next page load.',
    )
    expect(logSpies.error).toHaveBeenCalledWith(
      'Failed to clear the external ID from storage — it may resurface on the next page load.',
    )
  })

  const storeWith = (externalId: string) => {
    const setItem = vi.fn(() => true)
    const store = {
      crossSubdomain: true,
      getItem: (k: string) => (k === EXTERNAL_ID_KEY ? externalId : null),
      setItem,
      removeItem: () => true,
    }
    return { store, setItem }
  }

  it('does not re-write the persisted externalId at init while consent is denied', async () => {
    vi.resetModules()
    const profile = await import('./profile.js')
    const { store, setItem } = storeWith('user-42')
    profile.configureProfile(PROJECT_ID, store, () => false)
    // Restored into memory for consent-gated reads, but NOT persisted: no identity cookie write
    // while the user has not consented (threat-model constraint #6 — "no cookie while denied").
    expect(profile.resolveDistinctId()).toBe('user-42')
    expect(setItem).not.toHaveBeenCalled()
  })

  it('refreshes the persisted externalId at init when consent is granted', async () => {
    vi.resetModules()
    const profile = await import('./profile.js')
    const { store, setItem } = storeWith('user-42')
    profile.configureProfile(PROJECT_ID, store, () => true)
    expect(setItem).toHaveBeenCalledWith(EXTERNAL_ID_KEY, 'user-42')
  })

  it('refreshes the persisted externalId when no consent getter is provided (backward-compatible)', async () => {
    vi.resetModules()
    const profile = await import('./profile.js')
    const { store, setItem } = storeWith('user-42')
    profile.configureProfile(PROJECT_ID, store)
    expect(setItem).toHaveBeenCalledWith(EXTERNAL_ID_KEY, 'user-42')
  })

  it('logs an error when the external ID write does not land', async () => {
    vi.resetModules()
    const profile = await import('./profile.js')
    // A store whose writes never land (e.g. the shared cookie blocked mid-session): markIdentified
    // must surface it at error level — identification would otherwise silently not survive a reload.
    const store = { crossSubdomain: true, getItem: () => null, setItem: () => false, removeItem: () => true }
    profile.configureProfile(PROJECT_ID, store)
    profile.markIdentified('user-42')
    expect(logSpies.error).toHaveBeenCalledWith(
      'Failed to persist external ID to storage — identification will not survive page reload.',
    )
  })

  it('does not clear the shared cookie on destroyProfile so a re-init resumes identity', async () => {
    const jar = new CookieJar()

    const first = await pageLoad('https://app.example.com/', jar)
    const anonId = first.profile.getAnonymousId()
    // destroy() is a runtime teardown, not a logout — it must not wipe the shared identity cookie
    // (that would reset every sibling subdomain).
    first.profile.destroyProfile()

    localStorage.clear()
    const second = await pageLoad('https://www.example.com/', jar)
    expect(second.profile.getAnonymousId()).toBe(anonId)
  })

  it('does not resurrect a reset identity from a sibling origin after logout (cross-subdomain)', async () => {
    const jar = new CookieJar()

    // 1. User identifies on app.example.com.
    const app1 = await pageLoad('https://app.example.com/', jar)
    app1.profile.markIdentified('user-42')
    const appLocal = snapshotLocal() // app's localStorage holds user-42

    // 2. User visits www.example.com — the shared cookie recognizes them, backfilling www's localStorage.
    localStorage.clear()
    const www1 = await pageLoad('https://www.example.com/', jar)
    expect(www1.profile.resolveDistinctId()).toBe('user-42')
    const wwwLocal = snapshotLocal()
    expect(wwwLocal[EXTERNAL_ID_KEY]).toBe('user-42')

    // 3. Back on app, the user logs out — reset() clears the shared cookie and app's localStorage.
    restoreLocal(appLocal)
    const app2 = await pageLoad('https://app.example.com/', jar)
    app2.profile.clearProfile()

    // 4. User returns to www, whose localStorage still holds the stale user-42. The shared cookie is
    //    gone, so they must NOT be re-identified — and must not re-broadcast the stale id back into
    //    the shared cookie. (Regression: localStorage fallback used to resurrect it here.)
    restoreLocal(wwwLocal)
    const www2 = await pageLoad('https://www.example.com/', jar)
    expect(www2.profile.isIdentified()).toBe(false)
    expect(www2.profile.resolveDistinctId()).not.toBe('user-42')
    expect(www2.store?.getItem(EXTERNAL_ID_KEY)).toBeNull()
  })

  it('regenerates when the stored profile ID has an unexpected format', async () => {
    const jar = new CookieJar()
    const { profile, store } = await pageLoad('https://app.example.com/', jar)
    store?.setItem(PROFILE_KEY, 'not-prefixed')
    const anonId = profile.getAnonymousId()
    expect(anonId.startsWith('anon-')).toBe(true)
    expect(logSpies.warn).toHaveBeenCalledWith(
      'Stored profile ID has unexpected format (missing "anon-" prefix), regenerating.',
    )
  })

  it('warns when no persistence is available and still returns an ID', async () => {
    vi.resetModules()
    const profile = await import('./profile.js')
    profile.configureProfile(PROJECT_ID, null)
    expect(logSpies.warn).toHaveBeenCalledWith(
      'Storage unavailable; anonymous profile ID will not persist across page loads.',
    )
    expect(profile.getAnonymousId().startsWith('anon-')).toBe(true)
  })
})
