import { BatchCreateRequestSchema, Event } from '@buf/fivebits_cotton.bufbuild_es/events/v1/events_pb.js'
import { create, toBinary } from '@bufbuild/protobuf'
import { createRpcClients } from './rpc.js'

const toConnectEnvelope = (bytes: Uint8Array) => {
  const envelope = new Uint8Array(5 + bytes.byteLength)
  new DataView(envelope.buffer).setUint32(1, bytes.byteLength, false)
  envelope.set(bytes, 5)
  return envelope
}

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
        const blob = new Blob([toConnectEnvelope(bytes)], { type: 'application/connect+proto' })
        return navigator.sendBeacon(`${endpoint.replace(/\/$/, '')}/events.v1.EventsService/BatchCreate?x-api-key=${encodeURIComponent(token)}`, blob)
      } catch (err) {
        console.error('[Cotton SDK] beacon serialization/send failed:', err)
        return false
      }
    },
  }
}
