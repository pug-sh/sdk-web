import { CookieJar, JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isStorageAvailable, makeStorageKey } from './utils.js'

const logSpies = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

vi.mock('./logger.js', () => ({ log: logSpies }))

// Keep the real makeStorageKey; make isStorageAvailable controllable per test.
vi.mock('./utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./utils.js')>()
  return { ...actual, isStorageAvailable: vi.fn(() => true) }
})

const KEY = makeStorageKey('proj', 'consent')

// Dynamic import so the mocked logger is wired up before the module loads
// (matches the pattern in pug.test.ts).
const loadFactory = async () => (await import('./tracking-consent.js')).createTrackingConsent

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isStorageAvailable).mockReturnValue(true)
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createTrackingConsent', () => {
  it('defaults to granted with no config', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj')
    expect(consent.isGranted()).toBe(true)
    expect(consent.getConsent()).toBe('granted')
  })

  it('honors the default seed from the object form', async () => {
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', { initial: 'denied' }).getConsent()).toBe('denied')
  })

  it('honors the default seed from the string shorthand', async () => {
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', 'denied').getConsent()).toBe('denied')
  })

  it('fails closed to denied on an out-of-domain default seed and warns', async () => {
    const createTrackingConsent = await loadFactory()
    // The seed is runtime-untrusted despite its type: the CDN one-tag install feeds it from
    // data-options JSON, e.g. data-options='{"trackingConsent":{"initial":"Denied"}}'.
    const consent = createTrackingConsent('proj', { initial: 'Denied' as unknown as 'denied' })
    expect(consent.getConsent()).toBe('denied')
    expect(consent.isGranted()).toBe(false)
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining("failing closed to 'denied'"))
  })

  it('fails closed on an out-of-domain string-form config', async () => {
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', 'maybe' as unknown as 'denied').getConsent()).toBe('denied')
  })

  it('fails closed to denied on a non-object, non-string config shape', async () => {
    const createTrackingConsent = await loadFactory()
    // A mangled one-tag data-options interpolation can yield a primitive or array where a consent
    // object or string was intended, e.g. data-options='{"trackingConsent":true}' or '["denied"]'.
    // These have no `default`, so shape validation (not value validation) must catch them.
    for (const bad of [42, true, ['denied']] as unknown[]) {
      vi.clearAllMocks()
      const consent = createTrackingConsent('proj', bad as never)
      expect(consent.getConsent(), JSON.stringify(bad)).toBe('denied')
      expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining("failing closed to 'denied'"))
    }
  })

  it('accepts cookieless as a default seed and reports tracking active but not granted', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', 'cookieless')
    expect(consent.getConsent()).toBe('cookieless')
    expect(consent.isGranted()).toBe(false)
    expect(consent.isTracking()).toBe(true)
  })

  it('isTracking is true for granted, false for denied', async () => {
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', 'granted').isTracking()).toBe(true)
    expect(createTrackingConsent('proj', 'denied').isTracking()).toBe(false)
  })

  it('set() transitions between all three states and persists when enabled', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'granted', persist: true })
    consent.set('cookieless')
    expect(consent.getConsent()).toBe('cookieless')
    expect(localStorage.getItem(KEY)).toBe('cookieless')
    consent.set('denied')
    expect(consent.getConsent()).toBe('denied')
    consent.set('granted')
    expect(consent.getConsent()).toBe('granted')
  })

  it('restores a persisted cookieless choice over the default seed', async () => {
    const createTrackingConsent = await loadFactory()
    localStorage.setItem(KEY, 'cookieless')
    const consent = createTrackingConsent('proj', { initial: 'granted', persist: true })
    expect(consent.getConsent()).toBe('cookieless')
  })

  // Keeping the previous state here was a fail-OPEN: a CMP whose vocabulary is 'reject'/'opt-out',
  // or that passes null before the user answers, left a 'granted' user fully tracked while
  // isTrackingEnabled() confirmed the wrong state. init() already fails closed on the same untrusted
  // input, so runtime input now matches it.
  it.each([
    'Cookieless',
    'reject',
    'opt-out',
    'cookie-less',
    'cookieless ',
    false,
    null,
    undefined,
  ])('fails closed to denied and reports failure for the invalid state %p', async invalid => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', 'granted')
    expect(consent.set(invalid as never)).toBe(false)
    expect(consent.getConsent()).toBe('denied')
    expect(consent.isTracking()).toBe(false)
    expect(logSpies.error).toHaveBeenCalled()
  })

  it('reports success for a valid transition', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', 'granted')
    expect(consent.set('cookieless')).toBe(true)
    expect(consent.optOut()).toBe(true)
    expect(consent.optIn()).toBe(true)
  })

  // I8: a persist that does not land leaves the opt-out in memory only, so the next page load falls
  // back to the seed and silently re-consents the user. The caller has to be able to see that.
  it('reports failure when persistence was requested but is unavailable', async () => {
    const createTrackingConsent = await loadFactory()
    vi.mocked(isStorageAvailable).mockReturnValue(false)
    const consent = createTrackingConsent('proj', { initial: 'granted', persist: true })
    expect(consent.optOut()).toBe(false)
    expect(consent.getConsent()).toBe('denied')
  })

  it('reports success when persistence was never requested', async () => {
    const createTrackingConsent = await loadFactory()
    vi.mocked(isStorageAvailable).mockReturnValue(false)
    const consent = createTrackingConsent('proj', { initial: 'granted' })
    expect(consent.optOut()).toBe(true)
  })

  it('does not touch storage when persist is false', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'granted' })
    consent.optOut()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('writes granted to storage on optIn when persist is true', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'denied', persist: true })
    consent.optIn()
    expect(localStorage.getItem(KEY)).toBe('granted')
  })

  it('writes denied to storage on optOut when persist is true', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'granted', persist: true })
    consent.optOut()
    expect(localStorage.getItem(KEY)).toBe('denied')
  })

  it('restores a persisted value over the default seed', async () => {
    localStorage.setItem(KEY, 'denied')
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', { initial: 'granted', persist: true }).getConsent()).toBe('denied')
  })

  it('ignores an invalid persisted value and warns', async () => {
    localStorage.setItem(KEY, 'maybe')
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'granted', persist: true })
    expect(consent.getConsent()).toBe('granted')
    expect(logSpies.warn).toHaveBeenCalledWith(`Stored tracking consent at "${KEY}" is invalid, ignoring.`)
  })

  it('falls back to in-memory and warns when storage is unavailable', async () => {
    vi.mocked(isStorageAvailable).mockReturnValue(false)
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'denied', persist: true })
    consent.optIn()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(consent.getConsent()).toBe('granted')
    expect(logSpies.warn).toHaveBeenCalledWith(
      'Storage unavailable; tracking consent will not persist across page loads.',
    )
  })

  it('falls back to the seed and warns when reading storage throws', async () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('read boom')
    })
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'denied', persist: true })
    expect(consent.getConsent()).toBe('denied')
    expect(logSpies.warn).toHaveBeenCalledWith(`Failed to read "${KEY}" from localStorage:`, expect.any(Error))
  })

  it('does not throw and logs an error when persisting throws', async () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('write boom')
    })
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'granted', persist: true })
    expect(() => consent.optOut()).not.toThrow()
    expect(consent.getConsent()).toBe('denied')
    expect(logSpies.error).toHaveBeenCalledWith(
      'Failed to persist tracking consent to storage — opt in/out will not survive page reload.',
    )
  })
})

describe('pending vs decided', () => {
  it('is pending until the user answers, whatever the seed says', async () => {
    const createTrackingConsent = await loadFactory()
    // The hole this closes: a seeded 'granted' and a chosen 'granted' are the same value, so a
    // banner keyed on getConsent() re-prompts users who already opted in.
    expect(createTrackingConsent('proj', { initial: 'granted' }).isPending()).toBe(true)
    expect(createTrackingConsent('proj', { initial: 'cookieless' }).isPending()).toBe(true)
    expect(createTrackingConsent('proj').isPending()).toBe(true)
  })

  it('is decided after an explicit set(), including the fail-closed path', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj')
    consent.set('cookieless')
    expect(consent.isPending()).toBe(false)

    const failed = createTrackingConsent('proj')
    expect(failed.set('reject' as never)).toBe(false)
    expect(failed.getConsent()).toBe('denied')
    expect(failed.isPending()).toBe(false)
  })

  it('is decided when a choice is restored from storage', async () => {
    localStorage.setItem(KEY, 'cookieless')
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'granted', persist: true })
    expect(consent.getConsent()).toBe('cookieless')
    expect(consent.isPending()).toBe(false)
  })

  it('stays pending when persist is on but nothing was ever stored', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'denied', persist: true })
    expect(consent.isPending()).toBe(true)
    expect(consent.isAuthoritative()).toBe(false)
  })
})

describe('respectGpc', () => {
  const withGpc = (value: unknown): void => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value, configurable: true })
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'globalPrivacyControl')
  })

  it('is ignored unless opted into', async () => {
    withGpc(true)
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj').getConsent()).toBe('granted')
  })

  it('resolves to the reject state when the signal is set', async () => {
    withGpc(true)
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { respectGpc: true })
    expect(consent.getConsent()).toBe('denied')
    expect(consent.isTracking()).toBe(false)
  })

  it('follows onReject, so a cookieless site keeps identity-free counts', async () => {
    withGpc(true)
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { respectGpc: true, onReject: 'cookieless' })
    expect(consent.getConsent()).toBe('cookieless')
    expect(consent.isTracking()).toBe(true)
    expect(consent.isGranted()).toBe(false)
  })

  it('leaves the seed alone when the signal is absent or false', async () => {
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', { respectGpc: true }).getConsent()).toBe('granted')
    withGpc(false)
    expect(createTrackingConsent('proj', { respectGpc: true }).getConsent()).toBe('granted')
  })

  it('counts as decided, so no banner re-prompts a user who already opted out globally', async () => {
    withGpc(true)
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', { respectGpc: true }).isPending()).toBe(false)
  })

  // Gates init()'s identity purge: a GPC user's identity from an earlier consented visit must go.
  it('is authoritative, unlike a config seed', async () => {
    withGpc(true)
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', { respectGpc: true }).isAuthoritative()).toBe(true)
    expect(createTrackingConsent('proj', { initial: 'denied' }).isAuthoritative()).toBe(false)
  })

  it('yields to a choice the user made on this site', async () => {
    withGpc(true)
    localStorage.setItem(KEY, 'granted')
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { respectGpc: true, persist: true })
    expect(consent.getConsent()).toBe('granted')
  })

  it('yields to an explicit opt-in at runtime', async () => {
    withGpc(true)
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { respectGpc: true })
    expect(consent.optIn()).toBe(true)
    expect(consent.getConsent()).toBe('granted')
  })

  // Without persistence that opt-in dies with the page and GPC re-resolves on the next load, so the
  // banner never shows and the user has no way to accept durably.
  it('warns when it resolves consent with no way to record a later opt-in', async () => {
    withGpc(true)
    const createTrackingConsent = await loadFactory()
    createTrackingConsent('proj', { respectGpc: true })
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('persist'))
  })

  it('does not warn when the choice can be persisted', async () => {
    withGpc(true)
    const createTrackingConsent = await loadFactory()
    createTrackingConsent('proj', { respectGpc: true, persist: true })
    expect(logSpies.warn).not.toHaveBeenCalled()
  })

  it('does not warn when the signal is absent', async () => {
    const createTrackingConsent = await loadFactory()
    createTrackingConsent('proj', { respectGpc: true })
    expect(logSpies.warn).not.toHaveBeenCalled()
  })

  it('accepts the header spellings a polyfill might use', async () => {
    const createTrackingConsent = await loadFactory()
    for (const value of [1, '1']) {
      withGpc(value)
      expect(createTrackingConsent('proj', { respectGpc: true }).getConsent()).toBe('denied')
    }
  })

  it('ignores a truthy non-signal value', async () => {
    withGpc('yes')
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', { respectGpc: true }).getConsent()).toBe('granted')
  })

  it('warns and ignores a non-boolean respectGpc from data-options JSON', async () => {
    withGpc(true)
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { respectGpc: 'true' as unknown as boolean })
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('respectGpc'))
    expect(consent.getConsent()).toBe('granted')
  })
})

describe('onReject', () => {
  it('defaults to denied', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj')
    expect(consent.getRejectState()).toBe('denied')
    consent.optOut()
    expect(consent.getConsent()).toBe('denied')
  })

  it('routes optOut to cookieless when configured', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'cookieless', onReject: 'cookieless' })
    expect(consent.getRejectState()).toBe('cookieless')
    consent.optOut()
    expect(consent.getConsent()).toBe('cookieless')
    expect(consent.isTracking()).toBe(true)
    expect(consent.isGranted()).toBe(false)
    expect(consent.isPending()).toBe(false)
  })

  it('leaves set(denied) meaning literally denied', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { onReject: 'cookieless' })
    consent.set('denied')
    expect(consent.getConsent()).toBe('denied')
  })

  it('refuses granted with an error and falls back to denied', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { onReject: 'granted' as never })
    expect(consent.getRejectState()).toBe('denied')
    expect(logSpies.error).toHaveBeenCalledWith(
      "trackingConsent.onReject cannot be 'granted' — a rejection may not grant consent. Using 'denied'.",
    )
  })

  it('warns and falls back to denied on an out-of-domain value', async () => {
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', { onReject: 'nope' as never }).getRejectState()).toBe('denied')
    expect(logSpies.warn).toHaveBeenCalledWith(
      `Invalid trackingConsent.onReject "nope"; expected 'denied' or 'cookieless'. Using 'denied'.`,
    )
  })

  it('is a recognized key rather than an unknown one that fails closed', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'granted', onReject: 'cookieless' })
    expect(consent.getConsent()).toBe('granted')
    expect(logSpies.warn).not.toHaveBeenCalled()
  })
})

describe('createTrackingConsent with a provided store', () => {
  const createFakeStore = () => {
    const map = new Map<string, string>()
    const writes: string[] = []
    return {
      map,
      writes,
      crossSubdomain: true,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value)
        writes.push(value)
        return true
      },
      removeItem: (key: string) => {
        map.delete(key)
      },
    }
  }

  it('writes opt in/out through the provided store when persist is true', async () => {
    const createTrackingConsent = await loadFactory()
    const store = createFakeStore()
    const consent = createTrackingConsent('proj', { persist: true }, store)
    consent.optOut()
    expect(store.map.get(KEY)).toBe('denied')
    consent.optIn()
    expect(store.map.get(KEY)).toBe('granted')
  })

  // The I8 case that actually bites in production: the store is present and accepts the call but
  // reports the value will not survive (cross-subdomain cookie rejected, quota, the 3800-char cap).
  it('reports failure when the provided store cannot persist the choice', async () => {
    const createTrackingConsent = await loadFactory()
    const store = { ...createFakeStore(), setItem: () => false }
    const consent = createTrackingConsent('proj', { persist: true }, store)
    expect(consent.optOut()).toBe(false)
    expect(consent.getConsent()).toBe('denied')
    expect(logSpies.error).toHaveBeenCalledWith(
      'Failed to persist tracking consent to storage — opt in/out will not survive page reload.',
    )
  })

  it('restores consent from the provided store and refreshes it', async () => {
    const createTrackingConsent = await loadFactory()
    const store = createFakeStore()
    store.map.set(KEY, 'denied')
    const consent = createTrackingConsent('proj', { initial: 'granted', persist: true }, store)
    expect(consent.getConsent()).toBe('denied')
    // Restore re-writes the value so a cookie-backed store refreshes its expiry.
    expect(store.writes).toContain('denied')
  })

  it('ignores the provided store when persist is false', async () => {
    const createTrackingConsent = await loadFactory()
    const store = createFakeStore()
    const consent = createTrackingConsent('proj', 'granted', store)
    consent.optOut()
    expect(store.map.size).toBe(0)
  })

  it('logs an error when the store reports the opt in/out write did not persist', async () => {
    // A cross-subdomain store returns false when the cookie write fails — the choice will not
    // survive a reload or reach sibling subdomains, so the user-facing action must say so.
    const createTrackingConsent = await loadFactory()
    const store = createFakeStore()
    store.setItem = () => false
    const consent = createTrackingConsent('proj', { persist: true }, store)
    consent.optOut()
    expect(consent.getConsent()).toBe('denied')
    expect(logSpies.error).toHaveBeenCalledWith(
      'Failed to persist tracking consent to storage — opt in/out will not survive page reload.',
    )
  })

  it('warns and stays in-memory when persist is true but the provided store is null', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { initial: 'denied', persist: true }, null)
    expect(logSpies.warn).toHaveBeenCalledWith(
      'Storage unavailable; tracking consent will not persist across page loads.',
    )
    consent.optIn()
    expect(consent.getConsent()).toBe('granted')
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})

describe('cross-subdomain consent propagation (real cookie layer)', () => {
  // A fresh consent controller wired to a real cookie layer at `url`, over a shared jar so documents
  // at sibling subdomains see each other's domain-scoped cookie — exactly how an opt-out propagates.
  const consentAt = async (url: string, jar: CookieJar) => {
    vi.resetModules()
    const [{ createTrackingConsent }, { createCookieLayer }, { createPersistentStore }] = await Promise.all([
      import('./tracking-consent.js'),
      import('./cookie.js'),
      import('./persistence.js'),
    ])
    const doc = new JSDOM('', { url, cookieJar: jar }).window.document
    const store = createPersistentStore(createCookieLayer(true, doc))
    return createTrackingConsent('proj', { persist: true }, store)
  }

  it('an opt-out on one subdomain is seen as denied on a sibling subdomain', async () => {
    const jar = new CookieJar()

    const app = await consentAt('https://app.example.com/', jar)
    app.optOut()
    expect(app.getConsent()).toBe('denied')

    // Sibling origin: its own (empty) localStorage — only the shared cookie carries the choice.
    localStorage.clear()
    const www = await consentAt('https://www.example.com/', jar)
    expect(www.getConsent()).toBe('denied')
  })
})

// `persist` is read as `normalized.persist === true`, so any non-boolean silently becomes false.
// The CDN one-tag install feeds this from `data-options` JSON, where `"persist": "true"` is an easy
// mistake — and it fails in the quietest possible way: consent lives in memory only, init()'s purge
// never fires (isAuthoritative() is false), and setTrackingConsent() still returns true because
// write() short-circuits on !persist. Every other untrusted field in this file is validated.
describe('persist coercion', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('warns when persist is present but not a boolean', async () => {
    const { createTrackingConsent } = await import('./tracking-consent.js')
    createTrackingConsent('proj-persist-str', { initial: 'denied', persist: 'true' as never })

    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('persist'))
  })

  it('stays silent when persist is a real boolean or absent', async () => {
    const { createTrackingConsent } = await import('./tracking-consent.js')
    createTrackingConsent('proj-persist-ok', { initial: 'denied', persist: false })
    createTrackingConsent('proj-persist-absent', { initial: 'denied' })

    expect(logSpies.warn).not.toHaveBeenCalledWith(expect.stringContaining('persist'))
  })

  // R2-I7: every other untrusted input here warns and fails closed — a bad shape, a bad `persist`
  // type, a bad `default` value. An unrecognized *key* alone got nothing: `normalized.default` is
  // undefined, `seed !== undefined` is false, and `status` keeps its 'granted' initialiser. So a
  // typo'd privacy config fails OPEN. TypeScript catches this for npm consumers (TS2561), but the
  // one-tag install feeds this from `data-options` JSON in customer HTML, which no compiler sees —
  // and autoInitFromScript's own JSDoc promises "a mangled trackingConsent ... must not fall back
  // to consent granted".
  it('fails closed on an unrecognized config key instead of seeding granted', async () => {
    const { createTrackingConsent } = await import('./tracking-consent.js')
    const controller = createTrackingConsent('proj-typo', { defualt: 'denied', persist: true } as never)

    expect(controller.getConsent()).toBe('denied')
    expect(controller.isTracking()).toBe(false)
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('defualt'))
  })

  it('accepts the known keys without warning', async () => {
    const { createTrackingConsent } = await import('./tracking-consent.js')
    createTrackingConsent('proj-known', { initial: 'cookieless', persist: true })

    expect(logSpies.warn).not.toHaveBeenCalledWith(expect.stringContaining('Unknown'))
  })

  // `default` was renamed to `initial` (reserved word: `const { default } = cfg` is a SyntaxError).
  // TypeScript catches the rename for npm consumers, but the one-tag install supplies this as
  // untyped `data-options` JSON in customer HTML — so a deployment carrying the old key must fail
  // CLOSED and say why, not silently seed 'granted'. This is the safety net that makes the rename
  // safe rather than a silent privacy regression.
  it('fails closed on the pre-rename `default` key and names it', async () => {
    const { createTrackingConsent } = await import('./tracking-consent.js')
    // Deliberately the OLD key — this is the migration safety net, so it must not be renamed with
    // the rest of the suite. A stale one-tag deployment still sends `{"default":"denied"}`.
    const controller = createTrackingConsent('proj-stale', { default: 'denied', persist: true } as never)

    expect(controller.getConsent()).toBe('denied')
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('default'))
  })
})
