import { type BatchConfig, createBatchedTransport } from './batch.js'
import { eventClick, setupClickTracking } from './events/click.js'
import { eventFormStart, eventFormSubmit, setupFormTracking } from './events/form.js'
import { eventDeadClick, eventRageClick, setupDeadClickTracking, setupRageClickTracking } from './events/frustration.js'
import { eventPageView, setupPageViewTracking } from './events/page_view.js'
import { eventScroll, setupScrollTracking } from './events/scroll.js'
import { initUserAgentData } from './parsers.js'
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
}

interface CottonState {
  readonly config: CottonConfig
  readonly transport: ReturnType<typeof createBatchedTransport>
}

let state: CottonState | null = null
let cleanups: { name: string; fn: () => void }[] = []

export const init = (projectId: string, options: InitOptions) => {
  if (typeof window === 'undefined') {
    console.warn('[Cotton SDK] init() called in a non-browser environment, skipping.')
    return
  }

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('[Cotton SDK] projectId is required and must be a non-empty string')
  }

  if (!options.token || typeof options.token !== 'string') {
    throw new Error('[Cotton SDK] token is required and must be a non-empty string')
  }

  if (state) {
    console.warn('Cotton SDK already initialized')
    return
  }

  let samplingRate = options.samplingRate ?? 1
  if (samplingRate < 0 || samplingRate > 1) {
    console.warn(`[Cotton SDK] samplingRate must be between 0 and 1, got ${samplingRate}. Clamping.`)
    samplingRate = Math.max(0, Math.min(1, samplingRate))
  }

  // TODO(sampling): implement session-level sampling — either hash a device/user ID
  // for deterministic sampling or use a random per-session coin flip.

  const config: CottonConfig = { endpoint: options.endpoint || 'http://localhost:8080', projectId }

  cleanups = []

  try {
    initUserAgentData()
  } catch (err) {
    console.warn('[Cotton SDK] Failed to initialize user agent data:', err)
  }

  const transport = createBatchedTransport(config.endpoint, options.token, projectId, options.batch)

  state = { config, transport }

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
      console.error(`[Cotton SDK] Failed to initialize tracker "${setup.name}":`, err)
    }
  }
  if (failedCount > 0) {
    console.warn(`[Cotton SDK] ${failedCount}/${trackers.length} trackers failed to initialize.`)
  }
}

export const destroy = () => {
  if (typeof window === 'undefined') {
    return
  }

  if (!state) {
    console.warn('[Cotton SDK] destroy() called but SDK is not initialized.')
    return
  }

  for (const cleanup of cleanups) {
    try {
      cleanup.fn()
    } catch (err) {
      console.error(`[Cotton SDK] Error during cleanup of "${cleanup.name}":`, err)
    }
  }

  try {
    state.transport.destroy()
  } catch (err) {
    console.error('[Cotton SDK] Error during transport destroy:', err)
  }

  cleanups = []
  state = null
}

/** This function must never throw. Callers (e.g. monkey-patched history.pushState) rely on it being safe. */
export const track: TrackFn<CottonEventName> = (kind, props, opts) => {
  try {
    if (typeof window === 'undefined') {
      return
    }

    if (!state) {
      console.warn('Cotton SDK not initialized. Call init() first.')
      return
    }

    const immediate = opts?.immediate ?? false
    const event = toEvent(state.config.projectId, kind, props, opts)
    state.transport
      .send(event, { immediate })
      .catch((err: Error) => console.error(`[Cotton SDK] Failed to send event "${kind}":`, err))
  } catch (err) {
    // track() must never throw, but we defensively log the failure
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error(`[Cotton SDK] Unexpected error in track("${kind}"):`, err)
    }
  }
}
