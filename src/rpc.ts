import { createClient } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-web'
import { EventsService } from '@buf/fivebits_cotton.bufbuild_es/events/v1/events_pb.js'

export function createRpcClients(endpoint: string) {
  const transport = createConnectTransport({
    baseUrl: endpoint,
    useBinaryFormat: true,
  })

  return {
    eventsService: createClient(EventsService, transport),
  }
}
