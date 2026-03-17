import { BatchCreateRequestSchema, Event } from '@buf/fivebits_cotton.bufbuild_es/events/v1/events_pb.js'
import { create, toBinary } from '@bufbuild/protobuf'
import { createRpcClients } from './rpc.js'

export const createTransport = (endpoint: string, token: string) => {
  const { eventsService } = createRpcClients(endpoint, token)

  return {
    send: (event: Event) => eventsService.batchCreate(create(BatchCreateRequestSchema, { events: [event] })),
    sendBatch: (events: Event[]) => eventsService.batchCreate(create(BatchCreateRequestSchema, { events })),
    beacon: (events: Event[]) => {
      if (typeof navigator === 'undefined' || !navigator.sendBeacon) {
        return false
      }
      try {
        const bytes = toBinary(BatchCreateRequestSchema, create(BatchCreateRequestSchema, { events }))
        const blob = new Blob([bytes], { type: 'application/proto' })
        return navigator.sendBeacon(
          `${endpoint.replace(/\/$/, '')}/events.v1.EventsService/BatchCreate?api_key=${encodeURIComponent(token)}`,
          blob
        )
      } catch (err) {
        console.error('[Cotton SDK] beacon serialization/send failed:', err)
        return false
      }
    },
  }
}
