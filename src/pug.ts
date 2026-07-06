import { IdentifyRequestSchema, ProfilesSDKService } from '@buf/pugsh_pug.bufbuild_es/sdk/profiles/v1/profiles_pb.js'
import { create } from '@bufbuild/protobuf'
import { createValidator } from '@bufbuild/protovalidate'
import { createClient } from '@connectrpc/connect'
import { createApiTransport } from './api-transport.js'
import {
  type AutoCaptureConfig,
  type AutoCaptureController,
  type AutoCaptureSelection,
  createAutoCaptureController,
} from './auto-capture.js'
import { type BatchConfig, createBatchedTransport } from './batch.js'
import { type CrossSubdomainConfig, createCookieLayer } from './cookie.js'
import { log } from './logger.js'
import { initUserAgentData } from './parsers.js'
import { createPersistentStore, type PersistentStore } from './persistence.js'
import {
  clearProfile,
  configureProfile,
  destroyProfile,
  getAnonymousId,
  isIdentified,
  markIdentified,
  resolveDistinctId,
} from './profile.js'
import {
  clearSession,
  configureSession,
  destroySession,
  resetIdentity,
  resolveSessionId,
  type SessionConfig,
} from './session.js'
import { configureUrlSanitizer, type JsonValue, type TrackFn, type TrackOptions, toEvent } from './track.js'
import {
  createTrackingConsent,
  type TrackingConsent,
  type TrackingConsentConfig,
  type TrackingConsentController,
} from './tracking-consent.js'
import { DEFAULT_ENDPOINT, DEVICE_ID_KEY } from './utils.js'

export interface PugConfig {
  readonly endpoint: string
  readonly projectId: string
}

export interface InitOptions {
  readonly endpoint?: string
  readonly apiKey: string
  readonly batch?: Partial<BatchConfig>
  readonly dryRun?: boolean
  readonly session?: SessionConfig
  readonly autoCapture?: AutoCaptureConfig
  readonly trackingConsent?: TrackingConsent | TrackingConsentConfig
  /**
   * Shares identity (anonymous ID, external ID, session state, persisted consent) across subdomains
   * of the same site via a first-party cookie on the registrable domain (e.g. `.example.com`).
   *
   * **Off by default.** Cross-subdomain identity trades browser-enforced same-origin isolation for
   * the weaker same-site trust model, so it must be a conscious opt-in per integrator — see
   * `docs/cross-domain-tracking-threat-model.md`.
   *
   * - `false` (default) — origin-scoped `localStorage` only; no shared cookie.
   * - `true` — discover the widest settable domain (eTLD+1) with a write-probe. Degrades to a
   *   host-only cookie on localhost and IP hosts, and to `localStorage` when cookies are blocked.
   *   Cookies set from an HTTPS page carry `Secure`, so identity is shared only among HTTPS
   *   subdomains — an HTTP subdomain cannot read them. ⚠️ On a custom multi-tenant registrable
   *   domain that is not on the Public Suffix List (e.g. `tenant-a.myplatform.com` and
   *   `tenant-b.myplatform.com` run as separate customers), the probe returns the shared
   *   `myplatform.com`, letting sibling tenants read and overwrite each other's identity. Prefer
   *   an explicit `{ domain }` in that topology.
   * - `{ domain }` — pin an explicit cookie domain (falls back to a host-only cookie with a warning
   *   when the browser rejects it or it does not cover the current host).
   *
   * With cross-subdomain sessions, the "rotate when all tabs closed" heuristic is disabled — sessions
   * end by idle/max timeout only, since tab liveness is unknowable across subdomains.
   */
  readonly crossSubdomainTracking?: CrossSubdomainConfig
  /**
   * Transforms `$url` and `$referrer` (on every event) and a form's `action` (on submit) before
   * they leave the device — e.g. to strip PII-bearing query params or mask path segments
   * (`/orders/12345` → `/orders/:orderId`). Called synchronously on the `track()` hot path, so keep
   * it cheap and side-effect-free. If it throws or returns a non-string the URL is dropped to an
   * empty string rather than sent raw. Note: this covers URL fields only — `$utm*` params are parsed
   * from the raw query string and are not routed through it, so avoid putting PII in UTM params.
   */
  readonly sanitizeUrl?: (url: string) => string
}

export type { AutoCaptureConfig, AutoCaptureSelection, CrossSubdomainConfig, TrackingConsent, TrackingConsentConfig }

interface PugState {
  readonly config: PugConfig
  readonly transport: ReturnType<typeof createBatchedTransport>
  readonly apiKey: string
  readonly dryRun: boolean
  readonly autoCapture: AutoCaptureController
  readonly trackingConsent: TrackingConsentController
}

const validator = createValidator()

let state: PugState | null = null

type ProfilesClient = ReturnType<typeof createClient<typeof ProfilesSDKService>>

let profilesClient: ProfilesClient | null = null

const getProfilesClient = (): ProfilesClient => {
  if (profilesClient) {
    return profilesClient
  }
  if (!state) {
    throw new Error('[Pug SDK] Cannot create profiles client: SDK not initialized')
  }
  profilesClient = createClient(ProfilesSDKService, createApiTransport(state.config.endpoint, state.apiKey))
  return profilesClient
}

export const init = (projectId: string, options: InitOptions) => {
  if (typeof window === 'undefined') {
    log.warn('init() called in a non-browser environment, skipping.')
    return
  }

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('[Pug SDK] projectId is required and must be a non-empty string')
  }

  if (!options.apiKey || typeof options.apiKey !== 'string') {
    throw new Error('[Pug SDK] apiKey is required and must be a non-empty string')
  }

  if (state) {
    log.warn('Already initialized.')
    return
  }

  const config: PugConfig = { endpoint: options.endpoint || DEFAULT_ENDPOINT, projectId }

  let store: PersistentStore | null = null
  try {
    store = createPersistentStore(createCookieLayer(options.crossSubdomainTracking ?? false))
  } catch (err) {
    log.warn('Failed to initialize persistence:', err)
  }

  // Create consent before configuring identity so the init-time expiry refresh in configureProfile
  // is gated on it — no identity cookie write while consent is denied (threat-model constraint #6).
  const trackingConsent = createTrackingConsent(projectId, options.trackingConsent, store)

  try {
    configureSession(projectId, options.session, store)
  } catch (err) {
    log.warn('Failed to configure session tracking:', err)
  }

  try {
    configureProfile(projectId, store, trackingConsent.isGranted)
  } catch (err) {
    log.warn('Failed to configure profile:', err)
  }

  try {
    initUserAgentData()
  } catch (err) {
    log.warn('Failed to initialize user agent data:', err)
  }

  configureUrlSanitizer(options.sanitizeUrl)

  const transport = createBatchedTransport(config.endpoint, options.apiKey, projectId, options.batch)
  const autoCapture = createAutoCaptureController(track, trackingConsent.isGranted)

  state = {
    config,
    transport,
    apiKey: options.apiKey,
    dryRun: options.dryRun ?? false,
    autoCapture,
    trackingConsent,
  }

  if (state.dryRun) {
    log.warn('Dry run mode enabled — events will not be sent.')
  }
  if (!state.trackingConsent.isGranted()) {
    log.warn(
      'Tracking consent is denied — automatic capture is off and track()/identify() are dropped until optInTracking() is called. Check isTrackingEnabled() to detect this state.',
    )
  }

  state.autoCapture.setDesired(options.autoCapture)

  log.debug('Initialized.')
}

export const setAutoCapture = (autoCapture: AutoCaptureConfig): void => {
  if (!state) {
    log.warn('setAutoCapture() called before init().')
    return
  }
  state.autoCapture.setDesired(autoCapture)
  if (!state.trackingConsent.isGranted()) {
    log.debug('setAutoCapture() stored selection; listeners activate after opt-in.')
  }
}

export const optInTracking = (): void => {
  if (!state) {
    log.warn('optInTracking() called before init().')
    return
  }
  state.trackingConsent.optIn()
  state.autoCapture.apply()
  log.debug('Tracking opted in.')
}

export const optOutTracking = (): void => {
  if (!state) {
    log.warn('optOutTracking() called before init().')
    return
  }
  state.trackingConsent.optOut()
  state.autoCapture.apply()
  // Opting out is a privacy action, so tear down persisted identity: no identifiers should linger
  // for a user who asked not to be tracked. In cross-subdomain mode this clears the shared cookie,
  // propagating the identity teardown across sibling subdomains. Consent itself stays persisted
  // (device-level) so the opt-out survives reloads; a later optInTracking() starts a fresh identity.
  clearProfile()
  clearSession()
  log.debug('Tracking opted out.')
}

/** Reflects tracking consent only — independent of `dryRun`, which suppresses delivery without changing consent. */
export const isTrackingEnabled = (): boolean => {
  if (!state) {
    log.warn('isTrackingEnabled() called before init().')
    return false
  }
  return state.trackingConsent.isGranted()
}

export const getTrackingConsent = (): TrackingConsent => {
  if (!state) {
    log.warn('getTrackingConsent() called before init().')
    return 'denied'
  }
  return state.trackingConsent.getConsent()
}

export const destroy = () => {
  if (typeof window === 'undefined') {
    return
  }

  if (!state) {
    log.warn('destroy() called but SDK is not initialized.')
    return
  }

  state.autoCapture.destroy()

  try {
    state.transport.destroy()
  } catch (err) {
    log.error('Error during transport destroy:', err)
  }

  destroySession()
  destroyProfile()
  configureUrlSanitizer(undefined)
  profilesClient = null

  state = null
}

export const reset = () => {
  if (typeof window === 'undefined') {
    return
  }
  if (!state) {
    log.warn('reset() called but SDK is not initialized.')
    return
  }
  try {
    resetIdentity()
  } catch (err) {
    log.error('Failed to reset identity:', err)
  }
  try {
    clearProfile()
  } catch (err) {
    log.error('Failed to clear profile:', err)
  }
  // profilesClient is intentionally preserved — it holds no per-user or per-session state,
  // only the endpoint and API key from init().
}

/**
 * Never throws — invalid input, calls before init(), denied consent, dryRun, and RPC failures are
 * logged and the promise resolves without sending. Callers may await it without their own try/catch.
 * On first identify, includes anonymousId (for profile merge) and, if available, deviceId (for push device linking).
 */
export const identify = async (externalId: string, traits?: Record<string, JsonValue>): Promise<void> => {
  try {
    if (typeof window === 'undefined') {
      log.warn('identify() called in a non-browser environment, skipping.')
      return
    }
    if (!state) {
      log.warn('identify() called before init().')
      return
    }
    if (!externalId || typeof externalId !== 'string') {
      log.error('identify() requires a non-empty externalId string.')
      return
    }
    if (!state.trackingConsent.isGranted()) {
      log.debug('identify() dropped because tracking consent is denied.')
      return
    }
    if (state.dryRun) {
      log.debug('dryRun: would identify')
      return
    }

    const firstIdentify = !isIdentified()
    let deviceId = ''
    if (firstIdentify) {
      try {
        deviceId = localStorage.getItem(DEVICE_ID_KEY) ?? ''
      } catch (err) {
        log.warn('localStorage access failed for device ID, skipping push device linking:', err)
      }
    }

    const req = create(IdentifyRequestSchema, {
      externalId,
      traits,
      ...(firstIdentify && { anonymousId: getAnonymousId() }),
      ...(deviceId && { deviceId }),
    })

    const validation = validator.validate(IdentifyRequestSchema, req)
    if (validation.kind !== 'valid') {
      const detail =
        validation.kind === 'invalid'
          ? validation.violations.map(v => `${v.field}: ${v.message}`).join(', ')
          : String(validation.error)
      log.error(`Invalid identify request: ${detail}`)
      return
    }

    try {
      const client = getProfilesClient()
      await client.identify(req)
      markIdentified(externalId)
    } catch (err) {
      log.error('Failed to identify:', err)
    }
  } catch (err) {
    // Don't interpolate externalId: it is frequently PII (email, account id).
    log.error('Unexpected error in identify():', err)
  }
}

/** This function must never throw. Callers (e.g. monkey-patched history.pushState) rely on it being safe. */
export const track: TrackFn = (kind: string, props?: Record<string, unknown>, opts?: TrackOptions) => {
  try {
    if (typeof window === 'undefined') {
      return
    }

    if (!state) {
      log.warn('track() called before init().')
      return
    }

    if (!state.trackingConsent.isGranted()) {
      log.debug(`track("${kind}") dropped because tracking consent is denied.`)
      return
    }

    log.debug(`track("${kind}")`)
    const immediate = opts?.immediate ?? false
    const event = toEvent(state.config.projectId, kind, resolveSessionId(), resolveDistinctId(), props, opts)
    if (!event) {
      // error already logged by toEvent
      return
    }
    if (state.dryRun) {
      log.debug(`dryRun: would send "${kind}"`)
      return
    }
    state.transport.send(event, { immediate }).catch((err: Error) => log.error(`Failed to send event "${kind}":`, err))
  } catch (err) {
    log.error(`Unexpected error in track("${kind}"):`, err)
  }
}
