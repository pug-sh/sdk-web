import { create, toBinary } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchCreateRequestSchema, BatchCreateResponseSchema, EventsService } from './gen/sdk/events/v1/events_pb.js'
import { log } from './logger.js'
import { RpcError, unaryCall } from './rpc.js'

const ENDPOINT = 'https://api.example.com'
const API_KEY = 'test-key'
const METHOD = EventsService.method.batchCreate
const BATCH_URL = 'https://api.example.com/sdk.events.v1.EventsService/BatchCreate'

const request = () => create(BatchCreateRequestSchema, { events: [] })

const okResponse = () => {
  const body = toBinary(BatchCreateResponseSchema, create(BatchCreateResponseSchema, {}))
  return new Response(body, { status: 200, headers: { 'content-type': 'application/proto' } })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('unaryCall', () => {
  it('POSTs binary protobuf to the service/method path with the api-key header', async () => {
    fetchMock.mockResolvedValue(okResponse())

    await unaryCall(ENDPOINT, API_KEY, METHOD, request())

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(BATCH_URL)
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/proto')
    expect(init.headers['connect-protocol-version']).toBe('1')
    expect(init.headers['x-api-key']).toBe(API_KEY)
    expect(init.body).toBeInstanceOf(Uint8Array)
  })

  it('strips trailing slashes from the endpoint', async () => {
    fetchMock.mockResolvedValue(okResponse())

    await unaryCall(`${ENDPOINT}//`, API_KEY, METHOD, request())

    expect(fetchMock.mock.calls[0][0]).toBe(BATCH_URL)
  })

  it('parses the binary protobuf response', async () => {
    fetchMock.mockResolvedValue(okResponse())

    const res = await unaryCall(ENDPOINT, API_KEY, METHOD, request())

    expect(res.$typeName).toBe('sdk.events.v1.BatchCreateResponse')
  })

  it('maps a Connect JSON error body to an RpcError with the numeric gRPC code', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'invalid_argument', message: 'bad request' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(unaryCall(ENDPOINT, API_KEY, METHOD, request())).rejects.toMatchObject({
      name: 'RpcError',
      code: 3, // InvalidArgument — permanent, so batch.ts drops rather than retries
      message: 'bad request',
    })
  })

  it('classifies a non-Connect HTTP error body by status class — 4xx permanent, 5xx transient', async () => {
    // A non-Connect error body (a proxy/CDN/WAF HTML page — e.g. a Cloudflare 403 bot block)
    // is classified by HTTP status. Without this, an unmapped status collapsed to unknown(2),
    // which batch.ts treats as transient and retries on every flush forever. 4xx client/proxy
    // errors the identical retry can't fix must be PERMANENT (dropped); 429 and 5xx stay transient.
    const cases: Array<[number, number]> = [
      [400, 3], // proxy 400 (non-Connect body) → invalid_argument, permanent (was internal/13, transient)
      [401, 16], // unauthenticated — permanent
      [403, 7], // permission_denied — permanent (the Cloudflare WAF/bot-block case)
      [404, 12], // unimplemented — permanent
      [405, 3], // method not allowed — permanent
      [413, 3], // payload too large — permanent (was unknown/2 → retried the oversized batch forever)
      [415, 3], // unsupported media type — permanent
      [431, 3], // request header fields too large — permanent
      [451, 3], // unavailable for legal reasons — permanent
      [408, 14], // request timeout — transient (retry)
      [429, 14], // rate limited — transient (retry)
      [500, 14], // internal server error — transient (retry)
      [502, 14], // bad gateway — transient
      [503, 14], // service unavailable — transient
      [504, 14], // gateway timeout — transient
    ]
    for (const [status, code] of cases) {
      fetchMock.mockResolvedValueOnce(new Response('<html>blocked</html>', { status }))
      await expect(unaryCall(ENDPOINT, API_KEY, METHOD, request())).rejects.toMatchObject({ code })
    }
  })

  it('surfaces a 2xx body that is not valid protobuf as a permanent (non-RpcError) failure', async () => {
    // A misconfigured proxy / captive portal / CDN health page can return 200 + HTML/JSON.
    // res.ok is true, so fromBinary runs and throws. That must NOT become a transient RpcError(14)
    // — batch.ts would retry it every flush forever. Surfaced raw so batch.ts's isPermanentError
    // (non-RpcError → permanent) drops the poison instead.
    fetchMock.mockResolvedValue(new Response('<html>captive portal</html>', { status: 200 }))

    const err = await unaryCall(ENDPOINT, API_KEY, METHOD, request()).catch(e => e)

    expect(err).not.toBeInstanceOf(RpcError)
    expect(err).toBeInstanceOf(Error)
  })

  it('surfaces a 2xx with a protobuf content-type but a garbage body as permanent (fromBinary backstop)', async () => {
    // A proxy can set the correct content-type while returning a truncated/garbage body, so the
    // content-type check passes and fromBinary is the backstop: 0x08 is a field-1 varint tag with
    // no value → "premature EOF". It must be permanent (non-RpcError), not a transient retry.
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([0x08]), { status: 200, headers: { 'content-type': 'application/proto' } }),
    )

    const err = await unaryCall(ENDPOINT, API_KEY, METHOD, request()).catch(e => e)

    expect(err).not.toBeInstanceOf(RpcError)
    expect(err).toBeInstanceOf(Error)
  })

  it('attaches the original error as `cause` when wrapping a network failure', async () => {
    const original = new TypeError('Failed to fetch')
    fetchMock.mockRejectedValue(original)

    const err = await unaryCall(ENDPOINT, API_KEY, METHOD, request()).catch(e => e)

    expect(err).toBeInstanceOf(RpcError)
    expect(err.code).toBe(14)
    expect(err.cause).toBe(original)
  })

  it('wraps a network failure as a transient RpcError (unavailable) so the batch layer retries', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const err = await unaryCall(ENDPOINT, API_KEY, METHOD, request()).catch(e => e)

    expect(err).toBeInstanceOf(RpcError)
    expect(err.code).toBe(14)
  })

  it('wraps a timeout (abort) as a transient RpcError (deadline_exceeded)', async () => {
    // Reject only once the request's own signal aborts, mimicking a stalled request.
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
    )

    await expect(unaryCall(ENDPOINT, API_KEY, METHOD, request(), 5)).rejects.toMatchObject({ code: 4 })
  })

  it('falls back to the HTTP status when the Connect JSON `code` string is unknown', async () => {
    // A JSON body whose `code` isn't a canonical Connect code (e.g. a non-Connect gateway) is
    // classified by HTTP status, not left uncoded. The `message` is still surfaced.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'im_a_teapot', message: 'nope' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(unaryCall(ENDPOINT, API_KEY, METHOD, request())).rejects.toMatchObject({
      code: 3, // 400 → invalid_argument (permanent)
      message: 'nope',
    })
  })

  it('falls back to the HTTP status and a synthesized message when `code`/`message` are non-strings', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 42, message: 99 }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(unaryCall(ENDPOINT, API_KEY, METHOD, request())).rejects.toMatchObject({
      code: 14, // 503 → unavailable (transient)
      message: 'HTTP 503',
    })
  })

  it('logs at debug (not error) when a non-2xx body is not Connect JSON', async () => {
    const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {})
    fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }))

    await expect(unaryCall(ENDPOINT, API_KEY, METHOD, request())).rejects.toBeInstanceOf(RpcError)

    expect(debugSpy).toHaveBeenCalled()
    debugSpy.mockRestore()
  })

  it('clears the timeout after a successful response so no abort lingers', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    fetchMock.mockResolvedValue(okResponse())

    await unaryCall(ENDPOINT, API_KEY, METHOD, request())

    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
