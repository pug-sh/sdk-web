import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import { BatchCreateRequestSchema, EventSchema } from '@buf/fivebits_cotton.bufbuild_es/events/v1/events_pb.js'
import { createRpcClients } from './rpc.js'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface TrackOptions {
  readonly immediate?: boolean
  /** Probability (0–1) that this event is sent. Defaults to 1 (always send). */
  readonly sampleRate?: number
}

export type TrackFn<T extends string = string> = (eventName: T, properties?: Record<string, JsonValue>, options?: TrackOptions) => void

export interface EventData {
  readonly eventName: string
  readonly properties: Readonly<Record<string, JsonValue>>
  readonly timestamp: number
}

export interface SendOptions {
  readonly immediate?: boolean
}

export interface Transport {
  send(event: EventData, options?: SendOptions): Promise<void>
  sendBatch?(events: readonly EventData[]): Promise<void>
  destroy?(): void
}

const SDK_PROPERTY_KEYS = ['projectId', 'url', 'referrer', 'userAgent'] as const

function toProtoEvent(event: EventData) {
  const sdkProperties: Record<string, string> = {}
  const userProperties: Record<string, string> = {}

  for (const [k, v] of Object.entries(event.properties)) {
    const value = typeof v === 'string' ? v : JSON.stringify(v)
    if ((SDK_PROPERTY_KEYS as readonly string[]).includes(k)) {
      sdkProperties[k] = value
    } else {
      userProperties[k] = value
    }
  }

  return create(EventSchema, {
    event: event.eventName,
    sdkProperties,
    userProperties,
    eventTime: timestampFromDate(new Date(event.timestamp)),
  })
}

export function createTransport(endpoint: string): Transport {
  if (typeof window === 'undefined') {
    return { async send() { } }
  }

  const { eventsService } = createRpcClients(endpoint)

  return {
    async send(event: EventData) {
      await eventsService.batchCreate(
        create(BatchCreateRequestSchema, { events: [toProtoEvent(event)] })
      )
    },

    async sendBatch(events: readonly EventData[]) {
      await eventsService.batchCreate(
        create(BatchCreateRequestSchema, { events: events.map(toProtoEvent) })
      )
    },

    destroy() {},
  }
}
