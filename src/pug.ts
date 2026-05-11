import { IdentifyRequestSchema, ProfilesSDKService } from '@buf/fivebits_pug.bufbuild_es/sdk/profiles/v1/profiles_pb.js'
import { create } from '@bufbuild/protobuf'
import { createValidator } from '@bufbuild/protovalidate'
import { createClient } from '@connectrpc/connect'
import { createApiTransport } from './api-transport.js'
import {
  type AutoCaptureController,
  type AutoCaptureOptions,
  type AutoCaptureSelection,
  createAutoCaptureController,
} from './auto-capture.js'
import { type BatchConfig, createBatchedTransport } from './batch.js'
import { log } from './logger.js'
import { initUserAgentData } from './parsers.js'
import {
  clearProfile,
  configureProfile,
  destroyProfile,
  getAnonymousId,
  isIdentified,
  markIdentified,
  resolveDistinctId,
} from './profile.js'
import { configureSession, destroySession, resetIdentity, resolveSessionId, type SessionConfig } from './session.js'
import { type JsonValue, type TrackFn, type TrackOptions, toEvent } from './track.js'
import {
  createTrackingConsent,
  type TrackingConsentController,
  type TrackingConsentStatus,
} from './tracking-consent.js'
import { DEVICE_ID_KEY } from './utils.js'

export interface PugConfig {
  readonly endpoint: string
  readonly projectId: string
}

export interface InitOptions {
  readonly endpoint?: string
  readonly apiKey: string
  readonly samplingRate?: number
  readonly batch?: Partial<BatchConfig>
  readonly dryRun?: boolean
  readonly session?: SessionConfig
  readonly autoCapture?: AutoCaptureOptions
  /** @deprecated Use autoCapture. */
  readonly autoTrack?: AutoCaptureOptions
  readonly optOutTrackingByDefault?: boolean
}

export type { AutoCaptureOptions, AutoCaptureSelection, TrackingConsentStatus }

/** @deprecated Use AutoCaptureSelection. */
export type AutoTrackSelection = AutoCaptureSelection
/** @deprecated Use AutoCaptureOptions. */
export type AutoTrackOptions = AutoCaptureOptions

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

const resolveInitialAutoCapture = (options: InitOptions): AutoCaptureOptions | undefined => {
  if (options.autoCapture !== undefined) {
    if (options.autoTrack !== undefined) {
      log.warn('Both autoCapture and deprecated autoTrack were provided. Using autoCapture.')
    }
    return options.autoCapture
  }
  if (options.autoTrack !== undefined) {
    log.warn('autoTrack is deprecated. Use autoCapture instead.')
    return options.autoTrack
  }
  return undefined
}

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

  let samplingRate = options.samplingRate ?? 1
  if (samplingRate < 0 || samplingRate > 1) {
    log.warn(`samplingRate must be between 0 and 1, got ${samplingRate}. Clamping.`)
    samplingRate = Math.max(0, Math.min(1, samplingRate))
  }

  // TODO(sampling): implement session-level sampling — either hash a device/user ID
  // for deterministic sampling or use a random per-session coin flip.

  const config: PugConfig = { endpoint: options.endpoint || 'https://polrotifications.circlejerk.in', projectId }

  try {
    configureSession(projectId, options.session)
  } catch (err) {
    log.warn('Failed to configure session tracking:', err)
  }

  try {
    configureProfile(projectId)
  } catch (err) {
    log.warn('Failed to configure profile:', err)
  }

  try {
    initUserAgentData()
  } catch (err) {
    log.warn('Failed to initialize user agent data:', err)
  }

  const transport = createBatchedTransport(config.endpoint, options.apiKey, projectId, options.batch)
  const trackingConsent = createTrackingConsent(options.optOutTrackingByDefault ?? false)
  const autoCapture = createAutoCaptureController(track)

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
  if (!state.trackingConsent.hasOptedIn()) {
    log.debug('Tracking is opted out by default.')
  }

  state.autoCapture.set(resolveInitialAutoCapture(options))

  log.debug('Initialized.')
}

export const setAutoCapture = (autoCapture: AutoCaptureOptions): void => {
  if (typeof window === 'undefined') {
    return
  }
  if (!state) {
    log.warn('setAutoCapture() called before init().')
    return
  }
  state.autoCapture.set(autoCapture)
}

export const optInTracking = (): void => {
  if (typeof window === 'undefined') {
    return
  }
  if (!state) {
    log.warn('optInTracking() called before init().')
    return
  }
  state.trackingConsent.optIn()
  log.debug('Tracking opted in.')
}

export const optOutTracking = (): void => {
  if (typeof window === 'undefined') {
    return
  }
  if (!state) {
    log.warn('optOutTracking() called before init().')
    return
  }
  state.trackingConsent.optOut()
  log.debug('Tracking opted out.')
}

export const hasOptedInTracking = (): boolean => state?.trackingConsent.hasOptedIn() ?? false

export const getTrackingConsentStatus = (): TrackingConsentStatus => state?.trackingConsent.getStatus() ?? 'denied'

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
 * Throws on invalid input (sync) and on RPC failure (async). Callers must handle errors.
 * On first identify, includes anonymousId (for profile merge) and, if available, deviceId (for push device linking).
 */
export const identify = async (externalId: string, traits?: Record<string, JsonValue>): Promise<void> => {
  if (typeof window === 'undefined') {
    log.warn('identify() called in a non-browser environment, skipping.')
    return
  }
  if (!state) {
    log.warn('identify() called before init().')
    return
  }
  if (!externalId || typeof externalId !== 'string') {
    throw new Error('[Pug SDK] identify() requires a non-empty externalId string')
  }
  if (!state.trackingConsent.hasOptedIn()) {
    log.debug('identify() dropped because tracking is opted out.')
    return
  }
  if (state.dryRun) {
    log.debug('dryRun: would identify')
    return
  }

  const client = getProfilesClient()

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
    throw new Error(`[Pug SDK] Invalid identify request: ${detail}`)
  }

  try {
    await client.identify(req)
    markIdentified(externalId)
  } catch (err) {
    log.error('Failed to identify:', err)
    throw err
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

    if (!state.trackingConsent.hasOptedIn()) {
      log.debug(`track("${kind}") dropped because tracking is opted out.`)
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
