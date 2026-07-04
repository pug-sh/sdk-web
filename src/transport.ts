import { BatchCreateRequestSchema, Event } from '@buf/pugsh_pug.bufbuild_es/sdk/events/v1/events_pb.js'
import { create, toBinary } from '@bufbuild/protobuf'
import { log } from './logger.js'
import { createRpcClients } from './rpc.js'

export const createTransport = (endpoint: string, apiKey: string) => {
  const { eventsService } = createRpcClients(endpoint, apiKey)

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
          `${endpoint.replace(/\/$/, '')}/sdk.events.v1.EventsService/BatchCreate?api_key=${encodeURIComponent(apiKey)}`,
          blob,
        )
      } catch (err) {
        log.error('beacon serialization/send failed:', err)
        return false
      }
    },
  }
}
