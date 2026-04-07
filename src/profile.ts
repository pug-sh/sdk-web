import { uuidv7 } from 'uuidv7'
import { log } from './logger.js'
import { isStorageAvailable, makeStorageKey } from './utils.js'

let storageKey = ''
let anonymousId = ''
// In-memory only (not persisted) — resets on every page load so the first identify() always
// sends anonymousId for server-side merge. The server handles duplicate merges idempotently.
let identified = false
let storage: Storage | null = null

export const configureProfile = (projectId: string): void => {
  storage = isStorageAvailable() ? localStorage : null
  if (!storage) {
    log.warn('Storage unavailable; anonymous profile ID will not persist across page loads.')
  }
  storageKey = makeStorageKey(projectId, 'profile')
}

export const getAnonymousId = (): string => {
  if (anonymousId) {
    return anonymousId
  }

  if (storage) {
    try {
      const stored = storage.getItem(storageKey)
      if (stored) {
        if (stored.startsWith('anon-')) {
          anonymousId = stored
          return anonymousId
        }
        log.warn('Stored profile ID has unexpected format (missing "anon-" prefix), regenerating.')
      }
    } catch (err) {
      log.warn('Failed to read profile from storage:', err)
    }
  }

  anonymousId = `anon-${uuidv7()}`
  if (storage) {
    try {
      storage.setItem(storageKey, anonymousId)
    } catch (err) {
      log.warn('Failed to persist profile to storage:', err)
    }
  }
  return anonymousId
}

export const isIdentified = (): boolean => identified

export const markIdentified = (): void => {
  identified = true
}

export const clearProfile = (): void => {
  if (storage) {
    try {
      storage.removeItem(storageKey)
    } catch (err) {
      log.warn('Failed to remove profile from storage:', err)
    }
  }
  anonymousId = ''
  identified = false
}

export const destroyProfile = (): void => {
  clearProfile()
  storageKey = ''
  storage = null
}
