import { uuidv7 } from 'uuidv7'
import { log } from './logger.js'
import { type PersistentStore, resolveStore } from './persistence.js'
import type { GrantedGate } from './tracking-consent.js'
import { makeStorageKey, RESERVED_DISTINCT_ID_PREFIX } from './utils.js'

let storageKey = ''
let externalIdKey = ''
let anonymousId = ''
let externalId = ''
let store: PersistentStore | null = null

export const configureProfile = (
  projectId: string,
  persistentStore: PersistentStore | null | undefined,
  // Required for the reason given on configureSession: an omitted gate reads as "permitted".
  isGranted: GrantedGate,
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
    // The reserved prefix belongs to the server's derived cookieless identities. identify() rejects
    // it as input, but that check cannot help a device already carrying one — written by an SDK
    // version predating it, or by a sibling subdomain still running one via the shared cookie.
    // Restoring it makes it the distinctId on every later event, and the server's message-level CEL
    // rule then rejects the ENTIRE batch as InvalidArgument, which the batch layer classifies
    // permanent — so every batch containing this user is committed and dropped, silently.
    // Removed rather than ignored, so the device is healed instead of merely tolerated.
    if (stored.startsWith(RESERVED_DISTINCT_ID_PREFIX)) {
      log.warn(
        `Stored external ID uses the reserved "${RESERVED_DISTINCT_ID_PREFIX}" prefix, discarding it. The user will be treated as anonymous until identify() is called again.`,
      )
      // Checked, not discarded: the message above asserts the device was healed. In cross-subdomain
      // mode cookie.remove() reports failure from its read-back with no log of its own, so a
      // poisoned value would survive and be re-read on every later init() while this claimed
      // otherwise. In-memory state is still correct for this load — the harm is the false claim.
      if (store && !store.removeItem(externalIdKey)) {
        log.error(
          `Failed to remove the reserved "${RESERVED_DISTINCT_ID_PREFIX}" external ID from storage; it will be re-read on the next page load.`,
        )
      }
    } else {
      externalId = stored
      if (isGranted?.() ?? true) {
        store?.setItem(externalIdKey, stored)
      }
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

/**
 * Drops the persisted anonymous and external IDs. Returns false when a removal could not be
 * confirmed — in cross-subdomain mode that means the shared identity cookie survived on the
 * registrable domain and will resurface on the next read, which callers acting on a consent
 * withdrawal must be able to detect rather than infer from console output.
 */
export const clearProfile = (): boolean => {
  let cleared = true
  // reset()/opt-out teardown: a failed removal in cross-subdomain mode means the shared identity
  // cookie survived and would resurface on the next read, so surface it at error level.
  if (store) {
    if (!store.removeItem(storageKey)) {
      log.error('Failed to clear the anonymous profile from storage — it may resurface on the next page load.')
      cleared = false
    }
    if (!store.removeItem(externalIdKey)) {
      log.error('Failed to clear the external ID from storage — it may resurface on the next page load.')
      cleared = false
    }
  }
  anonymousId = ''
  externalId = ''
  return cleared
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
