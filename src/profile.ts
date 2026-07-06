import { uuidv7 } from 'uuidv7'
import { log } from './logger.js'
import { type PersistentStore, resolveStore } from './persistence.js'
import { makeStorageKey } from './utils.js'

let storageKey = ''
let externalIdKey = ''
let anonymousId = ''
let externalId = ''
let store: PersistentStore | null = null

export const configureProfile = (
  projectId: string,
  persistentStore?: PersistentStore | null,
  isGranted?: () => boolean,
): void => {
  store = resolveStore(persistentStore)
  if (!store) {
    log.warn('Storage unavailable; anonymous profile ID will not persist across page loads.')
  }
  storageKey = makeStorageKey(projectId, 'profile')
  externalIdKey = makeStorageKey(projectId, 'external_id')

  // Restore persisted externalId from a previous identify() call into memory (it is consumed only by
  // the consent-gated track()/identify()). Re-write it so a cookie-backed store refreshes its expiry
  // for active users — but only while consent permits persisting identity: writing here while denied
  // would extend an identity cookie's TTL (and re-broadcast it to sibling subdomains) for a user who
  // has not consented. When no getter is passed (non-init callers, tests) the refresh is unchanged.
  const stored = store?.getItem(externalIdKey)
  if (stored) {
    externalId = stored
    if (isGranted?.() ?? true) {
      store?.setItem(externalIdKey, stored)
    }
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
    log.warn('Stored profile ID has unexpected format (missing "anon-" prefix), regenerating.')
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
  // reset()/opt-out teardown: a failed removal in cross-subdomain mode means the shared identity
  // cookie survived and would resurface on the next read, so surface it at error level.
  if (store) {
    if (!store.removeItem(storageKey)) {
      log.error('Failed to clear the anonymous profile from storage — it may resurface on the next page load.')
    }
    if (!store.removeItem(externalIdKey)) {
      log.error('Failed to clear the external ID from storage — it may resurface on the next page load.')
    }
  }
  anonymousId = ''
  externalId = ''
}

export const destroyProfile = (): void => {
  // Teardown, not logout: leave persisted identity in place so a later init() resumes it. Removing
  // the shared cross-subdomain cookie here would wipe identity for every sibling subdomain.
  // clearProfile() (via reset()) is the deliberate clear.
  anonymousId = ''
  externalId = ''
  storageKey = ''
  externalIdKey = ''
  store = null
}
