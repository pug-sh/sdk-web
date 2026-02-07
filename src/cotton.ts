import { type BatchConfig, DEFAULT_BATCH_CONFIG, createBatchedTransport } from './batch.js'
import { type ClickEventName, setupClickTracking } from './events/click.js'
import { type FormEventName, setupFormTracking } from './events/form.js'
import { type DeadClickEventName, type RageClickEventName, setupDeadClickTracking, setupRageClickTracking } from './events/frustration.js'
import { type PageViewEventName, setupPageViewTracking } from './events/page_view.js'
import { type ScrollEventName, setupScrollTracking } from './events/scroll.js'
import { createRateLimitedTransport } from './rate-limit.js'
import { type EventData, type JsonValue, type TrackOptions, type Transport, createTransport } from './transport.js'

export type CottonEventName =
  | ClickEventName
  | DeadClickEventName
  | FormEventName
  | PageViewEventName
  | RageClickEventName
  | ScrollEventName
  | (string & {})

export interface CottonConfig {
  readonly endpoint: string
  readonly projectId: string
  readonly sampleRate: number
}

export interface InitOptions {
  readonly endpoint?: string
  readonly sampleRate?: number
  readonly rateLimit?: number
  readonly batch?: boolean | Partial<BatchConfig>
}

interface CottonState {
  readonly config: CottonConfig
  readonly transport: Transport
}

let state: CottonState | null = null
let cleanups: { name: string; fn: () => void }[] = []

export function init(projectId: string, options: InitOptions = {}) {
  if (typeof window === 'undefined') {
    console.warn('[Cotton SDK] init() called in a non-browser environment, skipping.')
    return
  }

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('[Cotton SDK] projectId is required and must be a non-empty string')
  }

  if (state) {
    console.warn('Cotton SDK already initialized')
    return
  }

  let sampleRate = options.sampleRate ?? 1
  if (sampleRate < 0 || sampleRate > 1) {
    console.warn(`[Cotton SDK] sampleRate must be between 0 and 1, got ${sampleRate}. Clamping.`)
    sampleRate = Math.max(0, Math.min(1, sampleRate))
  }
  const config: CottonConfig = {
    projectId,
    endpoint: options.endpoint || 'http://localhost:8080',
    sampleRate,
  }

  cleanups = []
  let transport: Transport = createTransport(config.endpoint)

  if (options.batch) {
    const merged = typeof options.batch === 'object'
      ? { ...DEFAULT_BATCH_CONFIG, ...options.batch }
      : DEFAULT_BATCH_CONFIG
    if (merged.maxSize < 1) console.warn('[Cotton SDK] batch.maxSize must be >= 1, using default.')
    if (merged.maxWaitMs < 0) console.warn('[Cotton SDK] batch.maxWaitMs must be >= 0, using default.')
    if (merged.maxQueueSize < 1) console.warn('[Cotton SDK] batch.maxQueueSize must be >= 1, using default.')
    const batchConfig: BatchConfig = {
      ...merged,
      storageKey: `__cotton_queue_${projectId}__`,
      maxSize: merged.maxSize >= 1 ? merged.maxSize : DEFAULT_BATCH_CONFIG.maxSize,
      maxWaitMs: merged.maxWaitMs >= 0 ? merged.maxWaitMs : DEFAULT_BATCH_CONFIG.maxWaitMs,
      maxQueueSize: merged.maxQueueSize >= 1 ? merged.maxQueueSize : DEFAULT_BATCH_CONFIG.maxQueueSize,
    }
    transport = createBatchedTransport(transport, batchConfig)
  }

  const rateLimit = options.rateLimit ?? 0
  if (rateLimit >= 1) {
    transport = createRateLimitedTransport(transport, rateLimit)
  } else if (rateLimit > 0) {
    console.warn(`[Cotton SDK] rateLimit must be >= 1, got ${rateLimit}. Ignoring.`)
  }

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

export function destroy() {
  if (typeof window === 'undefined') return

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
    state.transport.destroy?.()
  } catch (err) {
    console.error('[Cotton SDK] Error during transport destroy:', err)
  }

  cleanups = []
  state = null
}

/** This function must never throw. Callers (e.g. monkey-patched history.pushState) rely on it being safe. */
export function track(eventName: CottonEventName, properties: Record<string, JsonValue> = {}, options?: TrackOptions) {
  try {
    if (typeof window === 'undefined') {
      return
    }

    if (!state) {
      console.warn('Cotton SDK not initialized. Call init() first.')
      return
    }

    const effectiveSampleRate = Math.max(0, Math.min(1, options?.sampleRate ?? state.config.sampleRate))
    if (effectiveSampleRate < 1 && Math.random() >= effectiveSampleRate) return

    const event: EventData = {
      eventName,
      properties: {
        ...properties,
        projectId: state.config.projectId,
        url: window.location.href,
        referrer: document.referrer,
        userAgent: navigator.userAgent,
      },
      timestamp: Date.now(),
    }
    const immediate = options?.immediate ?? false
    state.transport.send(event, { immediate }).catch(err => console.error(`[Cotton SDK] Failed to send event "${eventName}":`, err))
  } catch (err) {
    // track() must never throw, but we defensively log the failure
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error(`[Cotton SDK] Unexpected error in track("${eventName}"):`, err)
    }
  }
}
