import { uuidv7 } from 'uuidv7'
import { log } from './logger.js'
import { type PersistentStore, resolveStore } from './persistence.js'
import { isStorageAvailable, makeStorageKey } from './utils.js'

interface StoredState {
  readonly sessionId: string
  readonly startTime: number
  readonly lastActivityTime: number
  readonly deviceId: string
}

export interface SessionConfig {
  readonly idleTimeoutMinutes?: number
  readonly maxSessionMinutes?: number
}

const DEFAULT_CONFIG = {
  idleTimeoutMs: 30 * 60 * 1000,
  maxSessionMs: 1440 * 60 * 1000,
  storageKey: '',
}

const HEARTBEAT_INTERVAL_MS = 10_000

// In cross-subdomain mode the session state rides a shared cookie the browser attaches to every
// request, so persisting lastActivityTime on each event would rewrite that cookie constantly.
// Throttle the activity-time refresh to at most once per this interval; the in-memory state stays
// exact and session-id changes (rotate/resetIdentity) still persist immediately, so only the
// persisted lastActivityTime lags — bounded by this interval, negligible against the idle timeout.
const ACTIVITY_PERSIST_THROTTLE_MS = 10_000

let config = { ...DEFAULT_CONFIG }

let state: StoredState | null = null
let store: PersistentStore | null = null
// Tab registry stays on raw localStorage: tab liveness is origin-local bookkeeping and must never
// ride a cookie (chatty writes on a header-bearing channel, and meaningless on other subdomains).
let tabsStorage: Storage | null = null
let tabsKey = ''
let tabId = ''
let lastHeartbeat = 0
let lastPersistMs = 0
let fallbackSessionId = ''
let onPageHide: (() => void) | null = null

export const configureSession = (
  projectId: string,
  sessionConfig?: SessionConfig,
  persistentStore?: PersistentStore | null,
): void => {
  store = resolveStore(persistentStore)
  if (!store) {
    log.warn('Storage unavailable; session state will not persist.')
  }
  fallbackSessionId = uuidv7()
  config.storageKey = makeStorageKey(projectId, 'session')

  if (sessionConfig?.idleTimeoutMinutes != null) {
    if (sessionConfig.idleTimeoutMinutes > 0) {
      config.idleTimeoutMs = sessionConfig.idleTimeoutMinutes * 60 * 1000
    } else {
      log.warn('session.idleTimeoutMinutes must be > 0, using default.')
    }
  }
  if (sessionConfig?.maxSessionMinutes != null) {
    if (sessionConfig.maxSessionMinutes > 0) {
      config.maxSessionMs = sessionConfig.maxSessionMinutes * 60 * 1000
    } else {
      log.warn('session.maxSessionMinutes must be > 0, using default.')
    }
  }

  // With a cross-subdomain session, tab liveness (localStorage + pagehide) is the wrong signal:
  // an init on one subdomain with no live tabs there would rotate a session still active on a
  // sibling subdomain. In that mode sessions end by idle/max timeout only.
  if (store?.crossSubdomain) {
    return
  }

  tabsStorage = isStorageAvailable() ? localStorage : null
  tabsKey = makeStorageKey(projectId, 'tabs')
  tabId = Math.random().toString(36).slice(2)

  // Track active tabs via per-tab timestamps in localStorage.
  // On init, prune entries older than idleTimeoutMs. If none survive,
  // all tabs were closed — rotate session. Self-heals from crashed
  // tabs since stale entries are pruned automatically.
  if (tabsStorage) {
    try {
      let tabs: Record<string, number> = {}
      try {
        tabs = JSON.parse(tabsStorage.getItem(tabsKey) ?? '{}')
      } catch {
        // corrupted — start fresh
      }

      const now = Date.now()
      const alive: Record<string, number> = {}
      for (const [id, ts] of Object.entries(tabs)) {
        if (typeof ts === 'number' && now - ts < config.idleTimeoutMs) {
          alive[id] = ts
        }
      }

      const allTabsWereClosed = Object.keys(alive).length === 0
      alive[tabId] = now
      lastHeartbeat = now
      tabsStorage.setItem(tabsKey, JSON.stringify(alive))

      if (allTabsWereClosed) {
        const existing = read()
        if (existing) {
          rotate()
        }
      }

      onPageHide = () => {
        try {
          if (!tabsStorage) {
            return
          }
          const current: Record<string, number> = JSON.parse(tabsStorage.getItem(tabsKey) ?? '{}')
          delete current[tabId]
          tabsStorage.setItem(tabsKey, JSON.stringify(current))
        } catch {
          // storage may be unavailable during unload
        }
      }
      window.addEventListener('pagehide', onPageHide)
    } catch (err) {
      log.warn('Tab tracking initialization failed:', err)
    }
  }
}

const read = (): StoredState | null => {
  if (!store) {
    return null
  }
  try {
    const parsed = JSON.parse(store.getItem(config.storageKey) ?? 'null')
    if (
      parsed &&
      typeof parsed.sessionId === 'string' &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.startTime === 'number' &&
      typeof parsed.lastActivityTime === 'number'
    ) {
      return parsed as StoredState
    }
  } catch {
    // Omit the parse error: its message can echo a fragment of the stored session JSON.
    log.warn('Failed to read session state; starting fresh.')
  }
  return null
}

const write = (s: StoredState): boolean => {
  if (!store) {
    return false
  }
  // setItem reports whether the value will survive a page load (in cross-subdomain mode that means
  // the cookie write landed). Advance the throttle clock only on a real persist, so a dropped write
  // isn't mistaken for a fresh one: it leaves lastPersistMs stale, and the next event re-attempts
  // the write instead of being suppressed for the throttle window. Underlying storage failures are
  // already logged by the store (once per key for the cross-subdomain cookie), so this frequent
  // path stays quiet; the deliberate rotate()/resetIdentity() callers surface their own failure below.
  const persisted = store.setItem(config.storageKey, JSON.stringify(s))
  if (persisted) {
    lastPersistMs = Date.now()
  }
  // Debounced heartbeat — only update if enough time has passed.
  if (tabsStorage && tabId && tabsKey) {
    try {
      const now = Date.now()
      if (now - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
        const tabs: Record<string, number> = JSON.parse(tabsStorage.getItem(tabsKey) ?? '{}')
        tabs[tabId] = now
        tabsStorage.setItem(tabsKey, JSON.stringify(tabs))
        lastHeartbeat = now
      }
    } catch (err) {
      log.warn('Failed to update tab registry:', err)
    }
  }
  return persisted
}

const isExpired = (s: StoredState): boolean => {
  const now = Date.now()
  return now - s.startTime > config.maxSessionMs || now - s.lastActivityTime > config.idleTimeoutMs
}

// Rotates session only — preserves deviceId across sessions
export const rotate = (): void => {
  if (!config.storageKey) {
    log.warn('rotate() called before init().')
    return
  }
  const now = Date.now()
  const deviceId = state?.deviceId ?? read()?.deviceId ?? uuidv7()
  const next: StoredState = { sessionId: uuidv7(), startTime: now, lastActivityTime: now, deviceId }
  state = next
  // A genuine persist failure (store present but the write did not land) means the new session id
  // will not survive a page load — surface it. `store &&` skips the in-memory-only case, which
  // configureSession already warned about.
  if (store && !write(next)) {
    log.warn('Failed to persist the rotated session; the new session id may not survive a page load.')
  }
}

export const resolveSessionId = (): string => {
  try {
    state = read() ?? state
    if (!state || isExpired(state)) {
      rotate()
    }

    if (!state) {
      log.warn('Session state unavailable after rotation attempt.')
      return fallbackSessionId
    }

    const next = { ...state, lastActivityTime: Date.now() }
    state = next
    // Origin-scoped stores persist every event (localStorage is cheap); cross-subdomain stores
    // throttle so the shared cookie is not rewritten on every event. A missing or expired session
    // was already persisted by rotate() above, so new session ids are never delayed.
    if (!store?.crossSubdomain || next.lastActivityTime - lastPersistMs >= ACTIVITY_PERSIST_THROTTLE_MS) {
      write(next)
    }
    return next.sessionId
  } catch (err) {
    log.warn('Failed to resolve session ID:', err)
    return state?.sessionId ?? fallbackSessionId
  }
}

// Resets both session and device ID — call on logout
export const resetIdentity = (): void => {
  const now = Date.now()
  const next: StoredState = { sessionId: uuidv7(), startTime: now, lastActivityTime: now, deviceId: uuidv7() }
  state = next
  // Logout/privacy-critical: a failed persist means the previous session and device id could
  // resurface on the next page load, so this is an error rather than a warning.
  if (store && !write(next)) {
    log.error('Failed to persist the identity reset; the previous session may resurface on the next page load.')
  }
}

// Clears the persisted session and in-memory state while leaving the module configured (store,
// keys, timeouts intact), so a later resolveSessionId() lazily starts a fresh session. Used by
// opt-out to drop identifiers without the full teardown destroySession() performs. In
// cross-subdomain mode this removes the shared cookie, so the opt-out propagates to sibling
// subdomains.
export const clearSession = (): void => {
  // opt-out teardown: a failed removal in cross-subdomain mode means the shared session
  // cookie survived and would resurface on the next read, so surface it at error level.
  if (store && !store.removeItem(config.storageKey)) {
    log.error('Failed to clear the session from storage — it may resurface on the next page load.')
  }
  state = null
  lastPersistMs = 0
}

export const destroySession = (): void => {
  if (onPageHide) {
    window.removeEventListener('pagehide', onPageHide)
    onPageHide = null
  }
  // Teardown, not logout: leave persisted session state in place so a later init() resumes it. In
  // cross-subdomain mode the session lives in a cookie shared by every sibling subdomain, so
  // removing it here would end sessions site-wide from an unrelated page's teardown. reset() (which
  // rotates to a fresh identity) and clearSession() (which removes it) are the deliberate discards.
  // Only this tab's origin-local registry entry is dropped, since this tab really is going away.
  try {
    if (tabsStorage && tabsKey && tabId) {
      const tabs: Record<string, number> = JSON.parse(tabsStorage.getItem(tabsKey) ?? '{}')
      delete tabs[tabId]
      if (Object.keys(tabs).length === 0) {
        tabsStorage.removeItem(tabsKey)
      } else {
        tabsStorage.setItem(tabsKey, JSON.stringify(tabs))
      }
    }
  } catch (err) {
    log.warn('Failed to update tab registry during destroy:', err)
  }
  state = null
  store = null
  tabsStorage = null
  tabsKey = ''
  tabId = ''
  lastHeartbeat = 0
  lastPersistMs = 0
  fallbackSessionId = ''
  config = { ...DEFAULT_CONFIG }
}
