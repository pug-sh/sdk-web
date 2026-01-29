import type { Transport, EventData } from './transport.js'
import { createTransport } from './transport.js'
import { setupPageViewTracking } from './events/page_view.js'
import { setupClickTracking } from './events/click.js'
import { setupScrollTracking } from './events/scroll.js'
import { setupFormTracking } from './events/form.js'
import { setupFrustrationTracking } from './events/frustration.js'

export interface CottonConfig {
  readonly endpoint: string
  readonly projectId: string
}

let config: CottonConfig
let transport: Transport
let initialized = false

export function init(projectId: string, options: { endpoint?: string } = {}) {
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

  setupPageViewTracking(track)
  setupClickTracking(track)
  setupScrollTracking(track)
  setupFormTracking(track)
  setupFrustrationTracking(track)
}

export function track(eventName: string, properties: Record<string, any> = {}) {
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
