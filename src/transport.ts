import { create, toBinary } from '@bufbuild/protobuf'
import { BatchCreateRequestSchema, type Event, EventsService } from './gen/sdk/events/v1/events_pb.js'
import { log } from './logger.js'
import { unaryCall } from './rpc.js'

export const createTransport = (endpoint: string, apiKey: string) => ({
  send: (event: Event) =>
    unaryCall(
      endpoint,
      apiKey,
      EventsService.method.batchCreate,
      create(BatchCreateRequestSchema, { events: [event] }),
    ),
  sendBatch: (events: Event[]) =>
    unaryCall(endpoint, apiKey, EventsService.method.batchCreate, create(BatchCreateRequestSchema, { events })),
  beacon: (events: Event[]) => {
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) {
      return false
    }
    try {
      const bytes = toBinary(BatchCreateRequestSchema, create(BatchCreateRequestSchema, { events }))
      const blob = new Blob([bytes], { type: 'application/proto' })
      return navigator.sendBeacon(
        `${endpoint.replace(/\/$/, '')}/sdk.events.v1.EventsService/BatchCreate?api_key=${encodeURIComponent(apiKey)}`,
        blob,
      )
    } catch (err) {
      log.error('beacon serialization/send failed:', err)
      return false
    }
  },
})
