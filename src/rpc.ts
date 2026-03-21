import { EventsService } from '@buf/fivebits_cotton.bufbuild_es/events/v1/events_pb.js'
import { createClient, type Interceptor } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-web'

const defaultTimeoutMs = 5000

export const createRpcClients = (endpoint: string, token: string) => {
  const interceptors: Interceptor[] = [
    next => async req => {
      req.header.set('x-api-key', token)
      return next(req)
    },
  ]

  const transport = createConnectTransport({
    baseUrl: endpoint,
    defaultTimeoutMs,
    interceptors,
    useBinaryFormat: true,
  })

  return {
    eventsService: createClient(EventsService, transport),
  }
}
