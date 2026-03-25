import { uuidv7 } from 'uuidv7'
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

let config = { ...DEFAULT_CONFIG }

let state: StoredState | null = null
let storage: Storage | null = null
let tabsKey = ''
let tabId = ''
let lastHeartbeat = 0
let fallbackSessionId = ''
let onPageHide: (() => void) | null = null

export const configureSession = (projectId: string, sessionConfig?: SessionConfig): void => {
  storage = isStorageAvailable() ? localStorage : null
  if (!storage) {
    console.warn('[Cotton SDK] Storage unavailable; session state will not persist.')
  }
  fallbackSessionId = uuidv7()
  config.storageKey = makeStorageKey(projectId, 'session')
  tabsKey = makeStorageKey(projectId, 'tabs')
  tabId = Math.random().toString(36).slice(2)

  if (sessionConfig?.idleTimeoutMinutes != null) {
    if (sessionConfig.idleTimeoutMinutes > 0) {
      config.idleTimeoutMs = sessionConfig.idleTimeoutMinutes * 60 * 1000
    } else {
      console.warn('[Cotton SDK] session.idleTimeoutMinutes must be > 0, using default.')
    }
  }
  if (sessionConfig?.maxSessionMinutes != null) {
    if (sessionConfig.maxSessionMinutes > 0) {
      config.maxSessionMs = sessionConfig.maxSessionMinutes * 60 * 1000
    } else {
      console.warn('[Cotton SDK] session.maxSessionMinutes must be > 0, using default.')
    }
  }

  // Track active tabs via per-tab timestamps in localStorage.
  // On init, prune entries older than idleTimeoutMs. If none survive,
  // all tabs were closed — rotate session. Self-heals from crashed
  // tabs since stale entries are pruned automatically.
  if (storage) {
    try {
      let tabs: Record<string, number> = {}
      try {
        tabs = JSON.parse(storage.getItem(tabsKey) ?? '{}')
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
      storage.setItem(tabsKey, JSON.stringify(alive))

      if (allTabsWereClosed) {
        const existing = read()
        if (existing) {
          rotate()
        }
      }

      onPageHide = () => {
        try {
          if (!storage) {
            return
          }
          const current: Record<string, number> = JSON.parse(storage.getItem(tabsKey) ?? '{}')
          delete current[tabId]
          storage.setItem(tabsKey, JSON.stringify(current))
        } catch {
          // storage may be unavailable during unload
        }
      }
      window.addEventListener('pagehide', onPageHide)
    } catch (err) {
      console.warn('[Cotton SDK] Tab tracking initialization failed:', err)
    }
  }
}

const read = (): StoredState | null => {
  if (!storage) {
    return null
  }
  try {
    const parsed = JSON.parse(storage.getItem(config.storageKey) ?? 'null')
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
    console.warn('[Cotton SDK] Failed to read session state (starting fresh):', err)
  }
  return null
}

const write = (s: StoredState): void => {
  if (!storage) {
    return
  }
  try {
    storage.setItem(config.storageKey, JSON.stringify(s))
    // Debounced heartbeat — only update if enough time has passed.
    const now = Date.now()
    if (tabId && tabsKey && now - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
      const tabs: Record<string, number> = JSON.parse(storage.getItem(tabsKey) ?? '{}')
      tabs[tabId] = now
      storage.setItem(tabsKey, JSON.stringify(tabs))
      lastHeartbeat = now
    }
  } catch (err) {
    console.warn('[Cotton SDK] Failed to persist state to storage:', err)
  }
}

const isExpired = (s: StoredState): boolean => {
  const now = Date.now()
  return now - s.startTime > config.maxSessionMs || now - s.lastActivityTime > config.idleTimeoutMs
}

// Rotates session only — preserves deviceId across sessions
export const rotate = (): void => {
  if (!config.storageKey) {
    console.warn('[Cotton SDK] rotate() called before init().')
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
      console.warn('[Cotton SDK] Session state unavailable after rotation attempt.')
      return fallbackSessionId
    }

    const next = { ...state, lastActivityTime: Date.now() }
    state = next
    write(next)
    return next.sessionId
  } catch (err) {
    console.warn('[Cotton SDK] Failed to resolve session ID:', err)
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
    storage?.removeItem(config.storageKey)
    // Only remove this tab's entry, not the entire tabs registry.
    if (storage && tabsKey && tabId) {
      const tabs: Record<string, number> = JSON.parse(storage.getItem(tabsKey) ?? '{}')
      delete tabs[tabId]
      if (Object.keys(tabs).length === 0) {
        storage.removeItem(tabsKey)
      } else {
        storage.setItem(tabsKey, JSON.stringify(tabs))
      }
    }
  } catch (err) {
    console.warn('[Cotton SDK] Failed to remove session state from storage:', err)
  }
  state = null
  storage = null
  tabsKey = ''
  tabId = ''
  lastHeartbeat = 0
  fallbackSessionId = ''
  config = { ...DEFAULT_CONFIG }
}
