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

let config = { ...DEFAULT_CONFIG }

let state: StoredState | null = null
let storage: Storage | null = null
let tabCounterKey = ''
let onPageHide: (() => void) | null = null

export const configureSession = (projectId: string, sessionConfig?: SessionConfig): void => {
  storage = isStorageAvailable() ? localStorage : null
  if (!storage) {
    console.warn('[Cotton SDK] Storage unavailable; session state will not persist.')
  }
  config.storageKey = makeStorageKey(projectId, 'session')
  tabCounterKey = makeStorageKey(projectId, 'tabs')

  // Track open tab count to detect "all tabs closed then reopened".
  // Increment on init, decrement on pagehide. If count was 0 when
  // this tab opened and a previous session exists, rotate.
  if (storage) {
    const prevCount = parseInt(storage.getItem(tabCounterKey) ?? '0', 10) || 0
    storage.setItem(tabCounterKey, String(prevCount + 1))

    if (prevCount === 0) {
      const existing = read()
      if (existing) {
        rotate()
      }
    }

    onPageHide = () => {
      try {
        const count = parseInt(storage!.getItem(tabCounterKey) ?? '1', 10) || 1
        storage!.setItem(tabCounterKey, String(Math.max(0, count - 1)))
      } catch {
        // storage may be unavailable during unload
      }
    }
    window.addEventListener('pagehide', onPageHide)
  }

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

    const next = { ...(state as StoredState), lastActivityTime: Date.now() }
    state = next
    write(next)
    return next.sessionId
  } catch (err) {
    console.warn('[Cotton SDK] Failed to resolve session ID:', err)
    return state?.sessionId ?? 'unknown'
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
    storage?.removeItem(tabCounterKey)
  } catch (err) {
    console.warn('[Cotton SDK] Failed to remove session state from storage:', err)
  }
  state = null
  storage = null
  tabCounterKey = ''
  config = { ...DEFAULT_CONFIG }
}
