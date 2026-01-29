import { Transport, GrpcTransport, EventData } from './transport'
import { setupPageViewTracking } from './events/page_view'
import { setupClickTracking } from './events/click'
import { setupScrollTracking } from './events/scroll'
import { setupFormTracking } from './events/form'
import { setupFrustrationTracking } from './events/frustration'

export interface CottonConfig {
  endpoint: string
  projectId: string
}

export default class Cotton {
  private static instance: Cotton
  private transport: Transport
  private config: CottonConfig

  private constructor(config: CottonConfig) {
    this.config = config
    this.transport = new GrpcTransport(config.endpoint)
    this.initTrackers()
  }

  public static init(projectId: string, options: { endpoint?: string } = {}) {
    if (Cotton.instance) {
      console.warn('Cotton SDK already initialized')
      return
    }

    const config: CottonConfig = {
      projectId,
      endpoint: options.endpoint || 'http://localhost:8080', // Default endpoint
    }

    Cotton.instance = new Cotton(config)
  }

  // Helper to access the singleton instance safely if needed internally,
  // or we can make static methods that delegate to instance.
  // For now, track listeners have reference to 'cotton' instance passed to them.
  // But if we want global access without passing instance everywhere, we might need a getter.
  // However, the current architecture passes 'this' to setup functions in constructor, which works fine.

  private initTrackers() {
    setupPageViewTracking(this)
    setupClickTracking(this)
    setupScrollTracking(this)
    setupFormTracking(this)
    setupFrustrationTracking(this)
  }

  public track(eventName: string, properties: Record<string, any> = {}) {
    const event: EventData = {
      eventName,
      properties: {
        ...properties,
        projectId: this.config.projectId,
        url: window.location.href,
        referrer: document.referrer,
        userAgent: navigator.userAgent,
      },
      timestamp: Date.now(),
    }
    this.transport.send(event)
  }
}
