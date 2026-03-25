import { type BatchConfig, createBatchedTransport } from './batch.js'
import { eventClick, setupClickTracking } from './events/click.js'
import { eventFormStart, eventFormSubmit, setupFormTracking } from './events/form.js'
import { eventDeadClick, eventRageClick, setupDeadClickTracking, setupRageClickTracking } from './events/frustration.js'
import { eventPageView, setupPageViewTracking } from './events/page_view.js'
import { eventScroll, setupScrollTracking } from './events/scroll.js'
import { log } from './logger.js'
import { initUserAgentData } from './parsers.js'
import { configureSession, destroySession, resetIdentity, resolveSessionId, type SessionConfig } from './session.js'
import { toEvent, type TrackFn } from './track.js'

export type CottonEventName =
  | typeof eventClick
  | typeof eventDeadClick
  | typeof eventFormStart
  | typeof eventFormSubmit
  | typeof eventPageView
  | typeof eventRageClick
  | typeof eventScroll
  | (string & {})

export interface CottonConfig {
  readonly endpoint: string
  readonly projectId: string
}

export interface InitOptions {
  readonly endpoint?: string
  readonly token: string
  readonly samplingRate?: number
  readonly batch?: Partial<BatchConfig>
  readonly dryRun?: boolean
  readonly session?: SessionConfig
}

interface CottonState {
  readonly config: CottonConfig
  readonly transport: ReturnType<typeof createBatchedTransport>
  readonly dryRun: boolean
}

let state: CottonState | null = null
let cleanups: { name: string; fn: () => void }[] = []

export const init = (projectId: string, options: InitOptions) => {
  if (typeof window === 'undefined') {
    log.warn('init() called in a non-browser environment, skipping.')
    return
  }

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('[Cotton SDK] projectId is required and must be a non-empty string')
  }

  if (!options.token || typeof options.token !== 'string') {
    throw new Error('[Cotton SDK] token is required and must be a non-empty string')
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
    console.warn('[Cotton SDK] Failed to configure session tracking:', err)
  }

  try {
    initUserAgentData()
  } catch (err) {
    log.warn('Failed to initialize user agent data:', err)
  }

  const transport = createBatchedTransport(config.endpoint, options.token, projectId, options.batch)

  state = { config, transport, dryRun: options.dryRun ?? false }

  if (state.dryRun) log.warn('Dry run mode enabled — events will not be sent.')

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
}

/** This function must never throw. Callers (e.g. monkey-patched history.pushState) rely on it being safe. */
export const track: TrackFn<CottonEventName> = (kind, props, opts) => {
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
    const event = toEvent(state.config.projectId, kind, resolveSessionId(), props, opts)
    if (state.dryRun) {
      log.debug(`dryRun: would send "${kind}"`)
      return
    }
    state.transport.send(event, { immediate }).catch((err: Error) => log.error(`Failed to send event "${kind}":`, err))
  } catch (err) {
    log.error(`Unexpected error in track("${kind}"):`, err)
  }
}
