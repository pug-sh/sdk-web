import { CookieJar, JSDOM } from 'jsdom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type CookieDocument, createCookieLayer, seekRegistrableDomain } from './cookie.js'

// A document whose writes are captured for assertion while reads/writes still delegate to a real
// jsdom cookie jar — so read-back verification and public-suffix rules stay faithful. Needed
// because jsdom's document.cookie read-back strips attributes (Secure, Max-Age, Domain, SameSite),
// leaving them otherwise unassertable.
const capturingDoc = (url: string): { doc: CookieDocument; writes: string[] } => {
  const real = new JSDOM('', { url }).window.document
  const { hostname, protocol } = new URL(url)
  const writes: string[] = []
  const doc: CookieDocument = {
    get cookie() {
      return real.cookie
    },
    set cookie(value: string) {
      writes.push(value)
      real.cookie = value
    },
    location: { hostname, protocol },
  }
  return { doc, writes }
}

const logSpies = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('./logger.js', () => ({ log: logSpies }))

// jsdom documents share a tough-cookie jar when constructed with the same CookieJar, which
// enforces real browser rules (public-suffix rejection, domain matching). Documents at different
// origins over one jar simulate a user moving between subdomains.
const docAt = (url: string, jar?: CookieJar): CookieDocument =>
  new JSDOM('', { url, ...(jar ? { cookieJar: jar } : {}) }).window.document

const KEY = '__pug_proj_profile__'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('seekRegistrableDomain', () => {
  it('finds eTLD+1 from a subdomain', () => {
    expect(seekRegistrableDomain(docAt('https://app.example.com/'))).toBe('example.com')
  })

  it('finds eTLD+1 from a deep subdomain', () => {
    expect(seekRegistrableDomain(docAt('https://a.b.c.example.com/'))).toBe('example.com')
  })

  it('walks past multi-label public suffixes like .co.uk', () => {
    expect(seekRegistrableDomain(docAt('https://foo.bar.co.uk/'))).toBe('bar.co.uk')
  })

  it('returns the hostname itself when already at the registrable domain', () => {
    expect(seekRegistrableDomain(docAt('https://example.com/'))).toBe('example.com')
  })

  it('cleans up its probe cookies', () => {
    const doc = docAt('https://app.example.com/')
    seekRegistrableDomain(doc)
    expect(doc.cookie).not.toContain('__pug_probe_')
  })
})

describe('createCookieLayer', () => {
  it('returns null when config is false', () => {
    expect(createCookieLayer(false, docAt('https://app.example.com/'))).toBeNull()
  })

  it('returns null and warns when the document refuses cookies', () => {
    const sandboxed: CookieDocument = {
      get cookie(): string {
        throw new Error('SecurityError')
      },
      set cookie(_value: string) {
        throw new Error('SecurityError')
      },
      location: { hostname: 'app.example.com', protocol: 'https:' },
    }
    expect(createCookieLayer(true, sandboxed)).toBeNull()
    expect(logSpies.warn).toHaveBeenCalledWith('Cookies unavailable; identity will not be shared across subdomains.')
  })

  it('shares values across subdomains via the registrable domain', () => {
    const jar = new CookieJar()
    const app = createCookieLayer(true, docAt('https://app.example.com/', jar))
    const www = createCookieLayer(true, docAt('https://www.example.com/', jar))

    expect(app?.crossSubdomain).toBe(true)
    expect(app?.set(KEY, 'anon-123')).toBe(true)
    expect(www?.get(KEY)).toBe('anon-123')
  })

  it('does not leak values to unrelated sites sharing the jar', () => {
    const jar = new CookieJar()
    const app = createCookieLayer(true, docAt('https://app.example.com/', jar))
    app?.set(KEY, 'anon-123')
    expect(docAt('https://app.other.org/', jar).cookie).not.toContain('anon-123')
  })

  it('uses a host-only cookie on localhost', () => {
    const layer = createCookieLayer(true, docAt('http://localhost:3000/'))
    expect(layer).not.toBeNull()
    expect(layer?.crossSubdomain).toBe(false)
    expect(layer?.set(KEY, 'v')).toBe(true)
    expect(layer?.get(KEY)).toBe('v')
  })

  it('uses a host-only cookie on IP hosts', () => {
    const layer = createCookieLayer(true, docAt('http://192.168.1.7/'))
    expect(layer?.crossSubdomain).toBe(false)
  })

  it('does not leak identity to sibling tenants on a multi-tenant platform', () => {
    // herokuapp.com is a public suffix, so the probe lands on the tenant's own host, not the
    // shared suffix — a sibling app must never see the value.
    const jar = new CookieJar()
    const app = createCookieLayer(true, docAt('https://myapp.herokuapp.com/', jar))
    expect(app?.set(KEY, 'anon-123')).toBe(true)
    expect(docAt('https://other.herokuapp.com/', jar).cookie).not.toContain('anon-123')
  })

  it('honors an explicit domain narrower than the registrable domain', () => {
    const jar = new CookieJar()
    const a = createCookieLayer({ domain: 'app.acme.com' }, docAt('https://a.app.acme.com/', jar))
    const b = createCookieLayer({ domain: 'app.acme.com' }, docAt('https://b.app.acme.com/', jar))

    expect(a?.crossSubdomain).toBe(true)
    a?.set(KEY, 'scoped')
    expect(b?.get(KEY)).toBe('scoped')
    // The whole point of pinning a narrower domain: siblings outside it must not see the cookie.
    expect(docAt('https://blog.acme.com/', jar).cookie).not.toContain('scoped')
  })

  it('normalizes a leading dot in an explicit domain', () => {
    const layer = createCookieLayer({ domain: '.app.acme.com' }, docAt('https://a.app.acme.com/'))
    expect(layer?.crossSubdomain).toBe(true)
  })

  it('falls back to host-only with a warning when the explicit domain does not cover the host', () => {
    const layer = createCookieLayer({ domain: 'evil.com' }, docAt('https://app.acme.com/'))
    expect(layer?.crossSubdomain).toBe(false)
    expect(logSpies.warn).toHaveBeenCalledWith(
      'crossSubdomainTracking domain "evil.com" is not usable on "app.acme.com"; using a host-only cookie instead.',
    )
  })

  it('falls back to host-only with a warning when the explicit domain is a public suffix', () => {
    const layer = createCookieLayer({ domain: 'co.uk' }, docAt('https://foo.bar.co.uk/'))
    expect(layer?.crossSubdomain).toBe(false)
    expect(logSpies.warn).toHaveBeenCalledWith(
      'crossSubdomainTracking domain "co.uk" is not usable on "foo.bar.co.uk"; using a host-only cookie instead.',
    )
  })

  it('round-trips values needing encoding', () => {
    const layer = createCookieLayer(true, docAt('https://app.example.com/'))
    const value = 'a; b=c, d €'
    expect(layer?.set(KEY, value)).toBe(true)
    expect(layer?.get(KEY)).toBe(value)
  })

  it('refuses oversized values and warns', () => {
    const layer = createCookieLayer(true, docAt('https://app.example.com/'))
    expect(layer?.set(KEY, 'x'.repeat(4000))).toBe(false)
    expect(logSpies.warn).toHaveBeenCalledWith(`Cookie for "${KEY}" would exceed 3800 chars; skipping cookie write.`)
  })

  it('returns false instead of throwing on malformed UTF-16 (lone surrogate)', () => {
    const layer = createCookieLayer(true, docAt('https://app.example.com/'))
    expect(layer?.set(KEY, '\uD800')).toBe(false)
  })

  it('logs the cause when a cookie write throws instead of silently swallowing it', () => {
    const layer = createCookieLayer(true, docAt('https://app.example.com/'))
    layer?.set(KEY, '\uD800') // encodeURIComponent throws inside writeCookie
    expect(logSpies.debug).toHaveBeenCalledWith(expect.any(String), expect.any(Error))
  })

  it('logs the cause when a cookie removal throws (privacy teardown must surface why)', () => {
    const layer = createCookieLayer(true, docAt('https://app.example.com/'))
    expect(layer?.remove('\uD800')).toBe(false) // encodeURIComponent(key) throws inside remove
    expect(logSpies.debug).toHaveBeenCalledWith(expect.any(String), expect.any(Error))
  })

  it('skips a malformed same-name twin and returns the valid shared value', () => {
    const jar = new CookieJar()
    const doc = docAt('https://app.example.com/', jar)
    // Malformed host-only twin, created first so it sorts ahead of the shared cookie.
    doc.cookie = `${KEY}=%E0%A4; path=/`
    const www = createCookieLayer(true, docAt('https://www.example.com/', jar))
    expect(www?.set(KEY, 'anon-good')).toBe(true)
    const app = createCookieLayer(true, doc)
    expect(app?.get(KEY)).toBe('anon-good')
  })

  it('returns null from get for a missing name', () => {
    const layer = createCookieLayer(true, docAt('https://app.example.com/'))
    expect(layer?.get('missing')).toBeNull()
  })

  it('removes values across subdomains', () => {
    const jar = new CookieJar()
    const app = createCookieLayer(true, docAt('https://app.example.com/', jar))
    const www = createCookieLayer(true, docAt('https://www.example.com/', jar))
    app?.set(KEY, 'v')
    app?.remove(KEY)
    expect(app?.get(KEY)).toBeNull()
    expect(www?.get(KEY)).toBeNull()
  })

  it('reports removal success via the return value', () => {
    const layer = createCookieLayer(true, docAt('https://app.example.com/'))
    layer?.set(KEY, 'v')
    expect(layer?.remove(KEY)).toBe(true)
    expect(layer?.get(KEY)).toBeNull()
  })

  it('clears a host-only twin on remove so it cannot be re-promoted later', () => {
    const jar = new CookieJar()
    const doc = docAt('https://app.example.com/', jar)
    // A legacy host-only twin coexisting with the shared cookie (older SDK / a prior host-only run).
    doc.cookie = `${KEY}=anon-legacy; path=/`
    const sibling = createCookieLayer(true, docAt('https://www.example.com/', jar))
    sibling?.set(KEY, 'anon-shared')

    const local = createCookieLayer(true, doc)
    // Removal must clear BOTH the shared cookie and the host-only twin, so a later reconcile on a
    // fresh page load finds nothing to promote back onto the shared cookie.
    expect(local?.remove(KEY)).toBe(true)

    const fresh = createCookieLayer(true, docAt('https://app.example.com/', jar))
    expect(fresh?.get(KEY)).toBeNull()
    expect(docAt('https://app.example.com/', jar).cookie).not.toContain(KEY)
  })

  it('returns false when a blocked cookie store cannot delete the value', () => {
    // A document that silently drops deletions (max-age=0 writes) while still reporting the value —
    // e.g. cookies blocked mid-session. remove() must report the failure, not assume success, so a
    // privacy teardown surfaces rather than silently leaving identity behind.
    const jar = new CookieJar()
    const real = new JSDOM('', { url: 'https://app.example.com/', cookieJar: jar }).window.document
    const doc: CookieDocument = {
      get cookie() {
        return real.cookie
      },
      set cookie(value: string) {
        if (value.includes('max-age=0')) return
        real.cookie = value
      },
      location: { hostname: 'app.example.com', protocol: 'https:' },
    }
    const layer = createCookieLayer(true, doc)
    expect(layer?.set(KEY, 'anon-123')).toBe(true)
    expect(layer?.remove(KEY)).toBe(false)
  })

  it('expires a stale host-only twin so it cannot shadow the shared cookie', () => {
    const jar = new CookieJar()
    const doc = docAt('https://app.example.com/', jar)
    doc.cookie = `${KEY}=stale; path=/`
    const layer = createCookieLayer(true, doc)
    expect(layer?.set(KEY, 'fresh')).toBe(true)
    expect(layer?.get(KEY)).toBe('fresh')
    expect(doc.cookie.split('; ').filter(part => part.startsWith(`${KEY}=`))).toHaveLength(1)
  })

  it('does not let a stale host-only twin shadow or corrupt the shared cookie on read', () => {
    const jar = new CookieJar()
    const doc = docAt('https://app.example.com/', jar)
    // A stale host-only twin, created first so it sorts ahead of the shared cookie on this origin.
    doc.cookie = `${KEY}=anon-stale; path=/`
    // The authoritative shared identity is written afterward (e.g. from a sibling subdomain).
    const www = createCookieLayer(true, docAt('https://www.example.com/', jar))
    expect(www?.set(KEY, 'anon-shared')).toBe(true)

    const app = createCookieLayer(true, doc)
    const read = app?.get(KEY)
    // Reads must resolve to the shared value, never the stale host-only twin.
    expect(read).toBe('anon-shared')
    // The SDK refreshes what it reads (to extend expiry); that must not promote the twin onto the
    // shared cookie. The sibling must still see the uncorrupted shared identity.
    app?.set(KEY, read as string)
    expect(www?.get(KEY)).toBe('anon-shared')
  })

  it('promotes a lone host-only value to the shared cookie so siblings inherit it', () => {
    const jar = new CookieJar()
    const doc = docAt('https://app.example.com/', jar)
    // Only a host-only value exists (e.g. left by a prior crossSubdomainTracking:false run).
    doc.cookie = `${KEY}=anon-legacy; path=/`
    const app = createCookieLayer(true, doc)
    expect(app?.crossSubdomain).toBe(true)
    expect(app?.get(KEY)).toBe('anon-legacy')
    // First access promotes it to the registrable domain, so a sibling now reads the same identity.
    expect(docAt('https://www.example.com/', jar).cookie).toContain(`${KEY}=anon-legacy`)
  })

  it('restores the host-only twin when promoting it to the shared cookie fails', () => {
    // A document that accepts probe/host-only writes but drops the long-lived domain-scoped identity
    // write (a browser that stops accepting domain cookies mid-session). The lone host-only value
    // must survive — restored — rather than be lost when the promotion write cannot land, since
    // cross-subdomain reads do not fall back to localStorage.
    const jar = new CookieJar()
    const real = new JSDOM('', { url: 'https://app.example.com/', cookieJar: jar }).window.document
    const doc: CookieDocument = {
      get cookie() {
        return real.cookie
      },
      set cookie(value: string) {
        if (value.includes('domain=.example.com') && value.includes('max-age=31536000')) return
        real.cookie = value
      },
      location: { hostname: 'app.example.com', protocol: 'https:' },
    }
    doc.cookie = `${KEY}=anon-legacy; path=/`
    const layer = createCookieLayer(true, doc)
    expect(layer?.crossSubdomain).toBe(true)
    expect(layer?.get(KEY)).toBe('anon-legacy')
  })
})

describe('cookie attributes', () => {
  const identityWrite = (writes: string[]): string | undefined => writes.find(w => w.includes('max-age=31536000'))

  it('writes Secure, SameSite=Lax, path, domain, and a 365-day max-age on https', () => {
    const { doc, writes } = capturingDoc('https://app.example.com/')
    const layer = createCookieLayer(true, doc)
    expect(layer?.set(KEY, 'v')).toBe(true)
    const write = identityWrite(writes)
    expect(write).toBeDefined()
    expect(write).toContain('; secure')
    expect(write).toContain('SameSite=Lax')
    expect(write).toContain('path=/')
    expect(write).toContain('domain=.example.com')
  })

  it('omits Secure on http so http subdomains can still read the cookie', () => {
    const { doc, writes } = capturingDoc('http://app.example.com/')
    const layer = createCookieLayer(true, doc)
    expect(layer?.set(KEY, 'v')).toBe(true)
    const write = identityWrite(writes)
    expect(write).toBeDefined()
    expect(write).not.toContain('secure')
  })
})
