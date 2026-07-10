import { create } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchCreateResponseSchema, type Event, EventSchema } from './gen/sdk/events/v1/events_pb.js'
import { log } from './logger.js'
import { GrpcCode, RpcError } from './rpc.js'

// A controllable stand-in for the inner RPC transport so we can drive batch.ts's flush routing
// (permanent → drop, transient → retain+retry) directly, without a real fetch. vi.hoisted lets
// the vi.mock factory (which is hoisted above imports) reference these mocks.
const { sendBatch, send, beacon } = vi.hoisted(() => ({
  sendBatch: vi.fn(),
  send: vi.fn(),
  beacon: vi.fn(),
}))
vi.mock('./transport.js', () => ({ createTransport: () => ({ send, sendBatch, beacon }) }))

const { createBatchedTransport } = await import('./batch.js')

const ENDPOINT = 'https://api.example.com'
const KEY = 'test-key'
let projectCounter = 0

const evt = (kind: string): Event => create(EventSchema, { kind })
const okResponse = (accepted: number) => create(BatchCreateResponseSchema, { accepted })
// A fresh project id per transport keeps each test's localStorage queue isolated.
const freshProject = () => `proj-${projectCounter++}`

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  sendBatch.mockReset()
  send.mockReset()
  beacon.mockReset().mockReturnValue(true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createBatchedTransport flush routing', () => {
  it('drops the whole batch on a permanent RpcError and never resends it', async () => {
    sendBatch.mockRejectedValue(new RpcError('denied', GrpcCode.PermissionDenied)) // code 7

    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 2, maxWaitMs: 50 })
    await t.send(evt('a'))
    await t.send(evt('b')) // size hits maxSize → flush()
    await vi.advanceTimersByTimeAsync(0) // settle the flush promise chain

    expect(sendBatch).toHaveBeenCalledTimes(1)

    // Batch was committed (dropped). Advancing well past any retry timer must not resend it.
    sendBatch.mockClear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sendBatch).not.toHaveBeenCalled()
  })

  it('treats a non-RpcError (TypeError from a codec/programming bug) as permanent and drops it', async () => {
    sendBatch.mockRejectedValue(new TypeError('boom'))

    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 1, maxWaitMs: 50 })
    await t.send(evt('a'))
    await vi.advanceTimersByTimeAsync(0)

    expect(sendBatch).toHaveBeenCalledTimes(1)

    sendBatch.mockClear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sendBatch).not.toHaveBeenCalled()
  })

  it('retains the batch on a transient RpcError and resends the same events on the next flush', async () => {
    sendBatch
      .mockRejectedValueOnce(new RpcError('unavailable', GrpcCode.Unavailable)) // code 14 → rollback
      .mockResolvedValueOnce(okResponse(1)) // retry succeeds

    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 1, maxWaitMs: 50 })
    await t.send(evt('a'))
    await vi.advanceTimersByTimeAsync(0)

    expect(sendBatch).toHaveBeenCalledTimes(1)

    // The failed flush leaves the event queued and schedules a retry. Fire the retry timer.
    await vi.advanceTimersByTimeAsync(60)

    expect(sendBatch).toHaveBeenCalledTimes(2)
    const resent = sendBatch.mock.calls[1][0] as Event[]
    expect(resent).toHaveLength(1)
    expect(resent[0].kind).toBe('a')
  })
})

describe('createBatchedTransport partial-acceptance reporting (C1)', () => {
  it('warns when the server accepts fewer events than were sent', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    sendBatch.mockResolvedValue(okResponse(1)) // sent 2, server accepted only 1

    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 2, maxWaitMs: 50 })
    await t.send(evt('a'))
    await t.send(evt('b'))
    await vi.advanceTimersByTimeAsync(0)

    expect(sendBatch).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1/2'))
    warnSpy.mockRestore()
  })

  it('does not warn when the server accepts every event', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    sendBatch.mockResolvedValue(okResponse(2))

    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 2, maxWaitMs: 50 })
    await t.send(evt('a'))
    await t.send(evt('b'))
    await vi.advanceTimersByTimeAsync(0)

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('accepted'))
    warnSpy.mockRestore()
  })
})
