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

let config: CottonConfig
let transport: Transport
let initialized = false

export function init(projectId: string, options: { endpoint?: string } = {}) {
  if (typeof window === 'undefined') {
    return
  }

  if (initialized) {
    console.warn('Cotton SDK already initialized')
    return
  }

  config = {
    projectId,
    endpoint: options.endpoint || 'http://localhost:8080',
  }

  transport = createTransport(config.endpoint)
  initialized = true

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
  if (!initialized) {
    console.warn('Cotton SDK not initialized. Call init() first.')
    return
  }

  const event: EventData = {
    eventName,
    properties: {
      ...properties,
      projectId: config.projectId,
      url: window.location.href,
      referrer: document.referrer,
      userAgent: navigator.userAgent,
    },
    timestamp: Date.now(),
  }
  transport.send(event).catch(err => console.error(`[Cotton SDK] Failed to send event "${eventName}":`, err))
}
