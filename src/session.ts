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
  } catch (err) {
    log.warn('Failed to read session state (starting fresh):', err)
  }
  return null
}

const write = (s: StoredState): void => {
  if (!store) {
    return
  }
  // Failures are logged inside the store; this runs frequently, so a second warn here would only
  // duplicate the noise.
  store.setItem(config.storageKey, JSON.stringify(s))
  lastPersistMs = Date.now()
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
  write(next)
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
  write(next)
}

export const destroySession = (): void => {
  if (onPageHide) {
    window.removeEventListener('pagehide', onPageHide)
    onPageHide = null
  }
  try {
    store?.removeItem(config.storageKey)
    // Only remove this tab's entry, not the entire tabs registry.
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
    log.warn('Failed to remove session state from storage:', err)
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
