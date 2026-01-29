import { type ClickEventName, setupClickTracking } from './events/click.js'
import { type FormEventName, setupFormTracking } from './events/form.js'
import { type FrustrationEventName, setupFrustrationTracking } from './events/frustration.js'
import { type PageViewEventName, setupPageViewTracking } from './events/page_view.js'
import { type ScrollEventName, setupScrollTracking } from './events/scroll.js'
import { type EventData, type JsonValue, type Transport, createTransport } from './transport.js'

export type CottonEventName =
  | ClickEventName
  | FormEventName
  | FrustrationEventName
  | PageViewEventName
  | ScrollEventName
  | (string & {})

export interface CottonConfig {
  readonly endpoint: string
  readonly projectId: string
}

let state: { config: CottonConfig; transport: Transport } | null = null

export function init(projectId: string, options: { endpoint?: string } = {}) {
  if (typeof window === 'undefined') {
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

  state = { config, transport: createTransport(config.endpoint) }

  const trackers = [
    setupPageViewTracking,
    setupClickTracking,
    setupScrollTracking,
    setupFormTracking,
    setupFrustrationTracking,
  ]

  for (const setup of trackers) {
    try {
      setup(track)
    } catch (err) {
      console.error(`[Cotton SDK] Failed to initialize tracker "${setup.name}":`, err)
    }
  }
}

export function track(eventName: CottonEventName, properties: Record<string, JsonValue> = {}) {
  if (!state) {
    console.warn('Cotton SDK not initialized. Call init() first.')
    return
  }

  try {
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
    console.error(`[Cotton SDK] Failed to track event "${eventName}":`, err)
  }
}
