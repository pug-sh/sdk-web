import {
  IdentifyRequestSchema,
  ProfilesSDKService,
} from '@buf/fivebits_cotton.bufbuild_es/sdk/profiles/v1/profiles_pb.js'
import { create } from '@bufbuild/protobuf'
import { createValidator } from '@bufbuild/protovalidate'
import { createClient } from '@connectrpc/connect'
import { createApiTransport } from './api-transport.js'
import { type BatchConfig, createBatchedTransport } from './batch.js'
import { setupClickTracking } from './events/click.js'
import { setupFormTracking } from './events/form.js'
import { setupDeadClickTracking, setupRageClickTracking } from './events/frustration.js'
import { setupPageViewTracking } from './events/page_view.js'
import { setupScrollTracking } from './events/scroll.js'
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
import { toEvent, type JSONValue, type TrackFn, type TrackOptions } from './track.js'

export interface CottonConfig {
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
  readonly autoTrack?: boolean
}

interface CottonState {
  readonly config: CottonConfig
  readonly transport: ReturnType<typeof createBatchedTransport>
  readonly apiKey: string
  readonly dryRun: boolean
}

const validator = createValidator()

let state: CottonState | null = null
let cleanups: { name: string; fn: () => void }[] = []

type ProfilesClient = ReturnType<typeof createClient<typeof ProfilesSDKService>>

let profilesClient: ProfilesClient | null = null

const getProfilesClient = (): ProfilesClient => {
  if (profilesClient) {
    return profilesClient
  }
  if (!state) {
    throw new Error('[Cotton SDK] Cannot create profiles client: SDK not initialized')
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
    throw new Error('[Cotton SDK] projectId is required and must be a non-empty string')
  }

  if (!options.apiKey || typeof options.apiKey !== 'string') {
    throw new Error('[Cotton SDK] apiKey is required and must be a non-empty string')
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

  const config: CottonConfig = { endpoint: options.endpoint || 'http://localhost:8080', projectId }

  cleanups = []

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

  state = { config, transport, apiKey: options.apiKey, dryRun: options.dryRun ?? false }

  if (state.dryRun) {
    log.warn('Dry run mode enabled — events will not be sent.')
  }

  const autoTrack = typeof options.autoTrack === 'boolean' ? options.autoTrack : true
  if (options.autoTrack !== undefined && !autoTrack) {
    log.warn(`autoTrack must be a boolean, got ${typeof options.autoTrack}. Defaulting to true.`)
  }

  if (!autoTrack) {
    log.warn('Initialized (autoTrack disabled — no trackers).')
    return
  }

  const trackers = [
    setupPageViewTracking,
    setupClickTracking,
    setupScrollTracking,
    setupFormTracking,
    setupRageClickTracking,
    setupDeadClickTracking,
  ]

  let failedCount = 0
  for (const setup of trackers) {
    try {
      const cleanup = setup(track)
      cleanups.push({ name: setup.name, fn: cleanup })
    } catch (err) {
      failedCount++
      log.error(`Failed to initialize tracker "${setup.name}":`, err)
    }
  }
  if (failedCount > 0) {
    log.warn(`${failedCount}/${trackers.length} trackers failed to initialize.`)
  }

  log.debug('Initialized.')
}

export const destroy = () => {
  if (typeof window === 'undefined') {
    return
  }

  if (!state) {
    log.warn('destroy() called but SDK is not initialized.')
    return
  }

  for (const cleanup of cleanups) {
    try {
      cleanup.fn()
    } catch (err) {
      log.error(`Error during cleanup of "${cleanup.name}":`, err)
    }
  }

  try {
    state.transport.destroy()
  } catch (err) {
    log.error('Error during transport destroy:', err)
  }

  destroySession()
  destroyProfile()
  profilesClient = null

  cleanups = []
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

/** Throws on invalid input (sync) and on RPC failure (async). Callers must handle errors. */
export const identify = async (externalId: string, traits?: Record<string, JSONValue>): Promise<void> => {
  if (typeof window === 'undefined') {
    log.warn('identify() called in a non-browser environment, skipping.')
    return
  }
  if (!state) {
    log.warn('identify() called before init().')
    return
  }
  if (!externalId || typeof externalId !== 'string') {
    throw new Error('[Cotton SDK] identify() requires a non-empty externalId string')
  }
  if (state.dryRun) {
    log.debug('dryRun: would identify')
    return
  }

  const client = getProfilesClient()

  const req = create(IdentifyRequestSchema, {
    externalId,
    traits,
    anonymousId: isIdentified() ? '' : getAnonymousId(),
  })

  const validation = validator.validate(IdentifyRequestSchema, req)
  if (validation.kind !== 'valid') {
    const detail =
      validation.kind === 'invalid'
        ? validation.violations.map(v => `${v.field}: ${v.message}`).join(', ')
        : String(validation.error)
    throw new Error(`[Cotton SDK] Invalid identify request: ${detail}`)
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
