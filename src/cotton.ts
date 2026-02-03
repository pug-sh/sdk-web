import { type ClickEventName, setupClickTracking } from './events/click.js'
import { type FormEventName, setupFormTracking } from './events/form.js'
import { type DeadClickEventName, type RageClickEventName, setupDeadClickTracking, setupRageClickTracking } from './events/frustration.js'
import { type PageViewEventName, setupPageViewTracking } from './events/page_view.js'
import { type ScrollEventName, setupScrollTracking } from './events/scroll.js'
import { type EventData, type JsonValue, type Transport, createTransport } from './transport.js'

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
}

interface CottonState {
  readonly config: CottonConfig
  readonly transport: Transport
}

let state: CottonState | null = null
let cleanups: { name: string; fn: () => void }[] = []

export function init(projectId: string, options: { endpoint?: string } = {}) {
  if (typeof window === 'undefined') {
    console.warn('[Cotton SDK] init() called in a non-browser environment, skipping.')
    return
  }

  if (state) {
    console.warn('Cotton SDK already initialized')
    return
  }

  const config: CottonConfig = {
    projectId,
    endpoint: options.endpoint || 'http://localhost:8080',
  }

  cleanups = []
  state = { config, transport: createTransport(config.endpoint) }

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
export function track(eventName: CottonEventName, properties: Record<string, JsonValue> = {}) {
  try {
    if (typeof window === 'undefined') {
      return
    }

    if (!state) {
      console.warn('Cotton SDK not initialized. Call init() first.')
      return
    }

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
    state.transport.send(event).catch(err => console.error(`[Cotton SDK] Failed to send event "${eventName}":`, err))
  } catch (err) {
    // track() must never throw, but we defensively log the failure
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error(`[Cotton SDK] Unexpected error in track("${eventName}"):`, err)
    }
  }
}
