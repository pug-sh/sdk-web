import { log } from './logger.js'

/**
 * Controls whether identity (anonymous ID, external ID, session state, persisted consent) is shared
 * across subdomains of the same site via a first-party cookie on the registrable domain.
 *
 * - `true` — discover the widest settable domain (eTLD+1, e.g. `.example.com`) with a write-probe.
 * - `false` — no cookie; persistence stays in origin-scoped localStorage.
 * - `{ domain }` — pin an explicit cookie domain, e.g. to scope narrower than the registrable
 *   domain (`app.acme.com` instead of `.acme.com`) or to a tenant slug on a multi-tenant platform.
 *   Falls back to a host-only cookie with a warning when the browser rejects the domain.
 */
export type CrossSubdomainConfig = boolean | { readonly domain: string }

/** Minimal document surface the cookie layer needs — injectable so tests can target other origins. */
export interface CookieDocument {
  cookie: string
  readonly location: { readonly hostname: string; readonly protocol: string }
}

export interface CookieLayer {
  get(name: string): string | null
  /** Returns true only when the write verifiably landed (read-back matches). */
  set(name: string, value: string): boolean
  /** Returns true only when the key is verifiably gone (read-back is null). */
  remove(name: string): boolean
  /** True when the cookie is scoped to a shared domain and therefore visible across subdomains. */
  readonly crossSubdomain: boolean
}

const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

/** Browsers cap a cookie (name + value + attributes) around 4096 bytes; refuse oversized writes early. */
const MAX_COOKIE_LENGTH = 3800

/** Bound on how many hostname labels the domain probe will consider. */
const PROBE_LABEL_LIMIT = 8

const isIpAddress = (hostname: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')

const probeName = (): string => `__pug_probe_${Math.random().toString(36).slice(2)}__`

const readCookie = (doc: CookieDocument, name: string): string | null => {
  try {
    const target = `${encodeURIComponent(name)}=`
    for (const part of doc.cookie.split('; ')) {
      if (part.startsWith(target)) {
        try {
          return decodeURIComponent(part.slice(target.length))
        } catch {
          // Malformed value on a same-named cookie (e.g. a foreign host-only twin) — keep
          // scanning; a valid twin at another scope may follow in the string.
        }
      }
    }
  } catch {
    // document.cookie can throw (sandboxed frame) — no usable value.
  }
  return null
}

/** True when the browser accepts a cookie scoped to `.domain` from the current page. */
const canUseCookieDomain = (doc: CookieDocument, domain: string): boolean => {
  const name = probeName()
  try {
    doc.cookie = `${name}=1; domain=.${domain}; path=/; max-age=3`
    const accepted = doc.cookie.includes(`${name}=`)
    if (accepted) {
      doc.cookie = `${name}=; domain=.${domain}; path=/; max-age=0`
    }
    return accepted
  } catch {
    return false
  }
}

/**
 * Finds the widest domain the browser will set a cookie on — the registrable domain (eTLD+1).
 * Probes widest-first: everything wider than eTLD+1 is a public suffix the browser refuses, so the
 * first accepted candidate is the answer. No bundled suffix list needed — the browser's own is
 * authoritative. Returns '' when nothing is accepted (caller falls back to a host-only cookie).
 */
export const seekRegistrableDomain = (doc: CookieDocument): string => {
  const labels = doc.location.hostname.split('.')
  const maxLabels = Math.min(labels.length, PROBE_LABEL_LIMIT)
  for (let n = 1; n <= maxLabels; n++) {
    const candidate = labels.slice(-n).join('.')
    if (candidate && canUseCookieDomain(doc, candidate)) {
      return candidate
    }
  }
  return ''
}

const resolveExplicitDomain = (doc: CookieDocument, requested: string): string => {
  const domain = requested.replace(/^\./, '').toLowerCase()
  const hostname = doc.location.hostname.toLowerCase()
  const coversHost = domain !== '' && (hostname === domain || hostname.endsWith(`.${domain}`))
  if (coversHost && canUseCookieDomain(doc, domain)) {
    return domain
  }
  log.warn(
    `crossSubdomainTracking domain "${requested}" is not usable on "${doc.location.hostname}"; using a host-only cookie instead.`,
  )
  return ''
}

/**
 * Creates the cookie layer used by `createPersistentStore()`, or null when cookies are disabled by
 * config or unavailable (blocked, sandboxed frame, non-browser environment). All failures degrade
 * to localStorage-only persistence — never throws.
 */
export const createCookieLayer = (
  config: CrossSubdomainConfig,
  doc: CookieDocument | null = typeof document === 'undefined' ? null : document,
): CookieLayer | null => {
  if (config === false || !doc) {
    return null
  }

  // Host-only availability probe — cookies can be blocked wholesale.
  const name = probeName()
  let available = false
  try {
    doc.cookie = `${name}=1; path=/; max-age=3`
    available = doc.cookie.includes(`${name}=`)
    if (available) {
      doc.cookie = `${name}=; path=/; max-age=0`
    }
  } catch {
    available = false
  }
  if (!available) {
    log.warn('Cookies unavailable; identity will not be shared across subdomains.')
    return null
  }

  const hostname = doc.location.hostname
  let domain = ''
  if (typeof config === 'object') {
    domain = resolveExplicitDomain(doc, config.domain)
  } else if (hostname && hostname !== 'localhost' && !isIpAddress(hostname)) {
    // Multi-tenant PaaS hosts (herokuapp.com, vercel.app, …) need no special-casing: their shared
    // suffix is a public suffix the browser rejects, so the widest-first probe lands on the
    // tenant's own host — never a domain a sibling tenant could read.
    domain = seekRegistrableDomain(doc)
  }

  const domainAttr = domain ? `; domain=.${domain}` : ''
  const secureAttr = doc.location.protocol === 'https:' ? '; secure' : ''
  const attrs = `; SameSite=Lax; path=/${domainAttr}${secureAttr}`
  // Keys already reconciled against a stale host-only twin this page load (see reconcileTwin).
  const reconciledKeys = new Set<string>()

  const writeCookie = (key: string, value: string): boolean => {
    try {
      // encodeURIComponent stays inside the try — it throws on malformed UTF-16 (lone surrogates),
      // and callers must never throw.
      const encoded = `${encodeURIComponent(key)}=${encodeURIComponent(value)}${attrs}; max-age=${COOKIE_MAX_AGE_SECONDS}`
      if (encoded.length > MAX_COOKIE_LENGTH) {
        log.warn(`Cookie for "${key}" would exceed ${MAX_COOKIE_LENGTH} chars; skipping cookie write.`)
        return false
      }
      doc.cookie = encoded
      return readCookie(doc, key) === value
    } catch (err) {
      log.debug(`Cookie write for "${key}" threw:`, err)
      return false
    }
  }

  // In cross-subdomain mode a same-named host-only cookie (a leftover twin from an earlier
  // host-only config, or a sibling that fell back to host-only) is indistinguishable by name from
  // the shared domain cookie in document.cookie and can sort ahead of it on reads. Left in place it
  // shadows the shared value — and worse, a read-then-refresh (getAnonymousId, session activity)
  // would copy the stale twin onto the shared domain cookie, corrupting identity for every
  // subdomain. Reconcile once per key on first access (read or write): expire the host-only twin,
  // then see what remains. A surviving value is the shared cookie and is authoritative; if nothing
  // remains the twin was the only value (a genuine host-only → shared migration) so re-promote it.
  // No-op in host-only mode (no shared cookie, so no twin risk).
  const reconcileTwin = (key: string): void => {
    if (!domainAttr || reconciledKeys.has(key)) {
      return
    }
    reconciledKeys.add(key)
    try {
      const before = readCookie(doc, key)
      if (before === null) {
        return // nothing present — no twin to reconcile
      }
      doc.cookie = `${encodeURIComponent(key)}=; path=/; max-age=0`
      if (readCookie(doc, key) !== null) {
        return // a shared cookie survives the host-only expiry and is authoritative — leave it
      }
      // Nothing remains: `before` was a lone host-only twin (a genuine host-only → shared
      // migration), so promote it to the shared cookie. If that write fails, restore the host-only
      // twin rather than leave the value gone entirely — cross-subdomain reads don't fall back to
      // localStorage, and the next page load will retry the promotion.
      if (!writeCookie(key, before)) {
        doc.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(before)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}`
      }
    } catch (err) {
      // Sandboxed frame or malformed key — nothing to reconcile; reads fall through to what exists.
      log.debug(`Cookie twin reconciliation for "${key}" threw:`, err)
    }
  }

  return {
    crossSubdomain: domainAttr !== '',
    get: key => {
      reconcileTwin(key)
      return readCookie(doc, key)
    },
    set: (key, value) => {
      reconcileTwin(key)
      return writeCookie(key, value)
    },
    remove: key => {
      // After an explicit remove there is no twin left worth reconciling on a later access.
      reconciledKeys.add(key)
      try {
        doc.cookie = `${encodeURIComponent(key)}=; path=/${domainAttr}; max-age=0`
        // Also clear a host-only twin so a removed key cannot resurrect from an older scope.
        if (domainAttr) {
          doc.cookie = `${encodeURIComponent(key)}=; path=/; max-age=0`
        }
        // Read back and report whether the key is actually gone. A cookie store blocked mid-session
        // no-ops the assignments above without throwing, so a privacy teardown (opt-out/reset) could
        // otherwise silently fail and let the shared identity cookie resurface on the next read.
        return readCookie(doc, key) === null
      } catch (err) {
        // Removal is best-effort, but surface why so a failed privacy teardown is diagnosable.
        log.debug(`Cookie removal for "${key}" threw:`, err)
        return false
      }
    },
  }
}
