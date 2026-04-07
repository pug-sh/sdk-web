import { EventsService } from '@buf/fivebits_cotton.bufbuild_es/sdk/events/v1/events_pb.js'
import { createClient } from '@connectrpc/connect'
import { createApiTransport } from './api-transport.js'

const defaultTimeoutMs = 5000

export const createRpcClients = (endpoint: string, apiKey: string) => {
  const transport = createApiTransport(endpoint, apiKey, { defaultTimeoutMs })

  return {
    eventsService: createClient(EventsService, transport),
  }
}
