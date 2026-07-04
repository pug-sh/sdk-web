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
  remove(name: string): void
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
  // Names whose stale host-only twin (from an earlier config without a domain attribute) was
  // expired — a leftover twin would shadow the shared cookie on reads.
  const cleanedTwins = new Set<string>()

  return {
    crossSubdomain: domainAttr !== '',
    get: key => readCookie(doc, key),
    set: (key, value) => {
      try {
        // encodeURIComponent stays inside the try — it throws on malformed UTF-16 (lone
        // surrogates), and set() must never throw.
        const encoded = `${encodeURIComponent(key)}=${encodeURIComponent(value)}${attrs}; max-age=${COOKIE_MAX_AGE_SECONDS}`
        if (encoded.length > MAX_COOKIE_LENGTH) {
          log.warn(`Cookie for "${key}" would exceed ${MAX_COOKIE_LENGTH} chars; skipping cookie write.`)
          return false
        }
        if (domainAttr && !cleanedTwins.has(key)) {
          cleanedTwins.add(key)
          doc.cookie = `${encodeURIComponent(key)}=; path=/; max-age=0`
        }
        doc.cookie = encoded
        return readCookie(doc, key) === value
      } catch {
        return false
      }
    },
    remove: key => {
      try {
        doc.cookie = `${encodeURIComponent(key)}=; path=/${domainAttr}; max-age=0`
        // Also clear a host-only twin so a removed key cannot resurrect from an older scope.
        if (domainAttr) {
          doc.cookie = `${encodeURIComponent(key)}=; path=/; max-age=0`
        }
      } catch {
        // Removal is best-effort.
      }
    },
  }
}
