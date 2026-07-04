import { uuidv7 } from 'uuidv7'
import { log } from './logger.js'
import { type PersistentStore, resolveStore } from './persistence.js'
import { makeStorageKey } from './utils.js'

let storageKey = ''
let externalIdKey = ''
let anonymousId = ''
let externalId = ''
let store: PersistentStore | null = null

export const configureProfile = (projectId: string, persistentStore?: PersistentStore | null): void => {
  store = resolveStore(persistentStore)
  if (!store) {
    log.warn('Storage unavailable; anonymous profile ID will not persist across page loads.')
  }
  storageKey = makeStorageKey(projectId, 'profile')
  externalIdKey = makeStorageKey(projectId, 'external_id')

  // Restore persisted externalId from a previous identify() call. Re-write it so a cookie-backed
  // store refreshes its expiry for active users.
  const stored = store?.getItem(externalIdKey)
  if (stored) {
    externalId = stored
    store?.setItem(externalIdKey, stored)
  }
}

export const getAnonymousId = (): string => {
  if (anonymousId) {
    return anonymousId
  }

  const stored = store?.getItem(storageKey)
  if (stored) {
    if (stored.startsWith('anon-')) {
      anonymousId = stored
      // Re-write so a cookie-backed store refreshes its expiry for active users.
      store?.setItem(storageKey, stored)
      return anonymousId
    }
    log.warn(`Stored profile ID "${stored}" has unexpected format (missing "anon-" prefix), regenerating.`)
  }

  anonymousId = `anon-${uuidv7()}`
  if (store && !store.setItem(storageKey, anonymousId)) {
    log.warn('Failed to persist profile to storage.')
  }
  return anonymousId
}

export const isIdentified = (): boolean => externalId !== ''

export const markIdentified = (id: string): void => {
  externalId = id
  if (store && !store.setItem(externalIdKey, id)) {
    log.error('Failed to persist external ID to storage — identification will not survive page reload.')
  }
}

export const resolveDistinctId = (): string => {
  return externalId || getAnonymousId()
}

export const clearProfile = (): void => {
  store?.removeItem(storageKey)
  store?.removeItem(externalIdKey)
  anonymousId = ''
  externalId = ''
}

export const destroyProfile = (): void => {
  clearProfile()
  storageKey = ''
  externalIdKey = ''
  store = null
}
