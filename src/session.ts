import { uuidv7 } from 'uuidv7'

import { isStorageAvailable } from './utils.js'

export interface SessionState {
  readonly sessionId: string
  readonly startTime: number
  readonly lastActivityTime: number
}

export interface SessionConfig {
  readonly idleTimeoutMinutes?: number
  readonly maxSessionSeconds?: number
}

const STORAGE_KEY = 'cotton_session_state'
const WRITE_DEBOUNCE_MS = 5 * 1000

let idleTimeoutMs = 30 * 60 * 1000
let maxSessionMs = 24 * 60 * 60 * 1000

/** @internal Called by cotton's init(). */
export const configureSession = (config: SessionConfig): void => {
  if (config.idleTimeoutMinutes) idleTimeoutMs = config.idleTimeoutMinutes * 60 * 1000
  if (config.maxSessionSeconds) maxSessionMs = config.maxSessionSeconds * 1000
}

let sessionState: SessionState | null = null
// undefined = not yet checked; null = checked, unavailable; Storage = available
let storageRef: Storage | null | undefined = undefined

const getStorage = (): Storage | null => {
  if (storageRef === undefined) {
    storageRef = isStorageAvailable(localStorage) ? localStorage : null
    if (!storageRef) console.warn('[SessionManager] Storage unavailable; session state will not persist.')
  }
  return storageRef
}

const readStorage = (): SessionState | null => {
  const s = getStorage()
  if (!s) return null
  try {
    const raw = s.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.sessionId === 'string') return parsed as SessionState
    return null
  } catch {
    return null
  }
}

const writeStorage = (state: SessionState): void => {
  const s = getStorage()
  if (!s) return
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // storage full or unavailable — session continues in memory
  }
}

const isExpired = (state: SessionState): boolean => {
  const now = Date.now()
  return now - state.startTime > maxSessionMs || now - state.lastActivityTime > idleTimeoutMs
}

export const rotate = (): void => {
  const newState: SessionState = { sessionId: uuidv7(), startTime: Date.now(), lastActivityTime: Date.now() }
  sessionState = newState
  writeStorage(newState)
}

/** @internal Called by cotton's track() on every event. */
export const resolveSessionId = (): string => {
  sessionState = readStorage() ?? sessionState
  if (!sessionState || isExpired(sessionState)) rotate()

  const now = Date.now()
  const state = sessionState!
  const next = { ...state, lastActivityTime: now }
  sessionState = next
  if (now - state.lastActivityTime > WRITE_DEBOUNCE_MS) writeStorage(next)
  return next.sessionId
}

/** Resets session state. Called automatically by cotton's destroy(). */
export const destroySession = (): void => {
  getStorage()?.removeItem(STORAGE_KEY)
  sessionState = null
  storageRef = undefined
  idleTimeoutMs = 30 * 60 * 1000
  maxSessionMs = 24 * 60 * 60 * 1000
}
