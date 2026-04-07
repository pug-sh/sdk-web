import { uuidv7 } from 'uuidv7'
import { log } from './logger.js'
import { isStorageAvailable, makeStorageKey } from './utils.js'

let storageKey = ''
let externalIdKey = ''
let anonymousId = ''
let externalId = ''
let storage: Storage | null = null

export const configureProfile = (projectId: string): void => {
  storage = isStorageAvailable() ? localStorage : null
  if (!storage) {
    log.warn('Storage unavailable; anonymous profile ID will not persist across page loads.')
  }
  storageKey = makeStorageKey(projectId, 'profile')
  externalIdKey = makeStorageKey(projectId, 'external_id')

  // Restore persisted externalId from a previous identify() call.
  if (storage) {
    try {
      const stored = storage.getItem(externalIdKey)
      if (stored) {
        externalId = stored
      }
    } catch (err) {
      log.warn('Failed to read external ID from storage:', err)
    }
  }
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
        log.warn(`Stored profile ID "${stored}" has unexpected format (missing "anon-" prefix), regenerating.`)
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

export const isIdentified = (): boolean => externalId !== ''

export const markIdentified = (id: string): void => {
  externalId = id
  if (storage) {
    try {
      storage.setItem(externalIdKey, id)
    } catch (err) {
      log.error('Failed to persist external ID to storage — identification will not survive page reload:', err)
    }
  }
}

export const resolveDistinctId = (): string => {
  return externalId || getAnonymousId()
}

export const clearProfile = (): void => {
  if (storage) {
    try {
      storage.removeItem(storageKey)
    } catch (err) {
      log.warn('Failed to remove anonymous profile from storage:', err)
    }
    try {
      storage.removeItem(externalIdKey)
    } catch (err) {
      log.warn('Failed to remove external ID from storage:', err)
    }
  }
  anonymousId = ''
  externalId = ''
}

export const destroyProfile = (): void => {
  clearProfile()
  storageKey = ''
  externalIdKey = ''
  storage = null
}
