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

const { createBatchedTransport: createRawBatchedTransport } = await import('./batch.js')

// Every transport registers `pagehide`/`visibilitychange` listeners in its constructor and only
// removes them in destroy(). Tests that never destroyed theirs left those listeners live, so a
// later `dispatchEvent('pagehide')` fired every previous test's beaconFlush too — the beacon test
// below passed only because those stale queues happened to be empty and ours registered last.
// Tracking every transport and destroying it in afterEach keeps that coupling out of the suite.
const liveTransports: Array<ReturnType<typeof createRawBatchedTransport>> = []
const createBatchedTransport = (...args: Parameters<typeof createRawBatchedTransport>) => {
  const t = createRawBatchedTransport(...args)
  liveTransports.push(t)
  return t
}

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
  for (const t of liveTransports.splice(0)) {
    t.destroy()
  }
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

describe('cookieless queue routing', () => {
  const cookielessEvt = (id: string): Event => create(EventSchema, { eventId: id, kind: 'k', cookieless: true })
  const consentedEvt = (id: string): Event =>
    create(EventSchema, { eventId: id, kind: 'k', sessionId: 's', distinctId: 'd' })

  it('never writes cookieless events to localStorage, even while retrying', async () => {
    const project = freshProject()
    const t = createBatchedTransport(ENDPOINT, KEY, project, { maxSize: 10, maxWaitMs: 50 })
    // Transient failure keeps the event queued past the localStorage queue's 1s
    // debounced persist — a single-queue implementation would write it to disk here.
    sendBatch.mockRejectedValue(new RpcError('down', GrpcCode.Unavailable))
    await t.send(cookielessEvt('c1'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(localStorage.getItem(`__pug_${project}_queue__`)).toBeNull()
    t.destroy()
  })

  it('flushes both queues', async () => {
    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 10, maxWaitMs: 50 })
    sendBatch.mockResolvedValue(okResponse(1))
    await t.send(consentedEvt('a'))
    await t.send(cookielessEvt('c'))
    await vi.advanceTimersByTimeAsync(200)
    const sentIds = sendBatch.mock.calls.flatMap(([events]: [Event[]]) => events.map(e => e.eventId))
    expect(sentIds.sort()).toEqual(['a', 'c'])
    t.destroy()
  })

  it('beacon drains both queues on page hide', async () => {
    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 10, maxWaitMs: 60_000 })
    await t.send(consentedEvt('a'))
    await t.send(cookielessEvt('c'))
    window.dispatchEvent(new Event('pagehide'))
    // Content-addressed rather than positional: find the call that carries our events instead of
    // assuming ours is last, so the assertion does not depend on listener registration order.
    const ourCall = (beacon.mock.calls as Array<[Event[]]>).find(([events]) =>
      events.some(e => e.eventId === 'a' || e.eventId === 'c'),
    )
    expect(ourCall?.[0].map(e => e.eventId).sort()).toEqual(['a', 'c'])
    t.destroy()
  })

  // I4: `target = storage.size > 0 ? storage : cookielessStorage` meant a continuous consented
  // stream always selected the consented queue, so cookieless events waited for a gap in traffic —
  // while `totalSize() >= maxSize` counted the stalled cookieless backlog and tripped the flush
  // threshold on every arriving event, degrading consented traffic to one request per event.
  it('drains cookieless events even under a continuous consented stream', async () => {
    sendBatch.mockResolvedValue(okResponse(10))
    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 10, maxWaitMs: 5000 })

    for (let i = 0; i < 9; i++) {
      await t.send(cookielessEvt(`c${i}`))
    }
    // A consented event every 2s for 24s — never a pause long enough for the old code to switch.
    for (let i = 0; i < 12; i++) {
      await t.send(consentedEvt(`a${i}`))
      await vi.advanceTimersByTimeAsync(2000)
    }

    const sentIds = sendBatch.mock.calls.flatMap(([events]: [Event[]]) => events.map(e => e.eventId))
    const cookielessSent = sentIds.filter(id => id.startsWith('c'))
    expect(cookielessSent).toHaveLength(9)
    // And the consented queue is genuinely batched rather than one request per event.
    expect(sendBatch.mock.calls.length).toBeLessThan(12)
  })

  it('builds a single batch from both queues, capped at maxSize', async () => {
    sendBatch.mockResolvedValue(okResponse(4))
    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 4, maxWaitMs: 50 })
    await t.send(consentedEvt('a1'))
    await t.send(cookielessEvt('c1'))
    await t.send(consentedEvt('a2'))
    await t.send(cookielessEvt('c2'))
    await vi.advanceTimersByTimeAsync(100)

    const [firstBatch] = sendBatch.mock.calls[0] as [Event[]]
    expect(firstBatch.map(e => e.eventId).sort()).toEqual(['a1', 'a2', 'c1', 'c2'])
    expect(firstBatch.length).toBeLessThanOrEqual(4)
  })

  // I6: identical failure (beacon returns false, which happens whenever sendBeacon is absent or
  // blocked — not only on payload rejection), but destroy() is the terminal path: the cookieless
  // queue is memory-only and dies with the transport, so its events are irrecoverable. That was
  // the one path with permanent loss and the one path with no logging at all.
  it('destroy() reports beacon failure, distinguishing recoverable from permanent loss', async () => {
    beacon.mockReturnValue(false)
    const warn = vi.spyOn(log, 'warn')
    const error = vi.spyOn(log, 'error')
    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 10, maxWaitMs: 60_000 })
    await t.send(consentedEvt('a'))
    await t.send(cookielessEvt('c'))

    t.destroy()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('remain in the persisted queue'))
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot be recovered'))
  })
})

describe('cookieless loss reporting and flush fairness', () => {
  const cookielessEvt = (id: string): Event => create(EventSchema, { eventId: id, kind: 'k', cookieless: true })

  // destroy() already splits these two levels; beaconFlush is the path that actually runs on every
  // real navigation and reported both as "they remain queued for next flush". For the memory-only
  // cookieless queue there is no next flush — it dies with the page, so the message said the
  // opposite of what happened. beacon() returns false whenever sendBeacon is absent or blocked,
  // which is routine with analytics-blocking extensions rather than exotic.
  it('reports a failed page-hide beacon of cookieless events as permanent loss', async () => {
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    beacon.mockReturnValue(false)
    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 50, maxWaitMs: 60_000 })
    await t.send(cookielessEvt('c1'))
    await t.send(cookielessEvt('c2'))

    // Scope the assertion to this dispatch alone: spies on the shared `log` object outlive a test
    // unless restored, so an unscoped one also sees other transports' teardown output.
    errSpy.mockClear()
    warnSpy.mockClear()
    window.dispatchEvent(new Event('pagehide'))

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('2 cookieless events'))
    // The consented queue contributed nothing, so nothing should claim to be recoverable.
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('remain in the persisted queue'))
    errSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('reports a failed page-hide beacon of consented events as recoverable', async () => {
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    beacon.mockReturnValue(false)
    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 50, maxWaitMs: 60_000 })
    await t.send(evt('a'))

    errSpy.mockClear()
    warnSpy.mockClear()
    window.dispatchEvent(new Event('pagehide'))

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 events'))
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('cookieless'))
    errSpy.mockRestore()
    warnSpy.mockRestore()
  })

  // Routing cookieless events to their own queue narrowed the starvation but did not close it: the
  // consented queue was drained first with the FULL maxSize budget, so `lock(maxSize - consented)`
  // was lock(0) on every flush whenever the consented backlog was >= maxSize. Measured before the
  // fix: 204 send attempts, none carrying a cookieless event.
  // maxSize is swept, not fixed at 3: the reservation `Math.max(1, maxSize - min(pending, ceil(n/2)))`
  // floors the consented budget at 1, which at maxSize:1 IS the whole budget — so cookieless got
  // lock(0) on every flush forever. maxSize:1 is legal (validated with min 1) and is the natural
  // choice for per-event delivery. A single fixed maxSize could never have caught it.
  it.each([
    1, 2, 3, 10,
  ])('does not starve cookieless events behind a maxSize consented backlog (maxSize: %i)', async maxSize => {
    sendBatch.mockRejectedValue(new RpcError('down', GrpcCode.Unavailable))
    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize, maxWaitMs: 500 })
    for (const k of ['b0', 'b1', 'b2']) {
      await t.send(evt(k))
    }
    await vi.advanceTimersByTimeAsync(3000)

    await t.send(cookielessEvt('c0'))
    await vi.advanceTimersByTimeAsync(5000)

    const attempted = sendBatch.mock.calls.flatMap((c: unknown) => (c as [Event[]])[0].map(e => e.eventId || e.kind))
    expect(attempted).toContain('c0')
  })

  // R2-C2: purgeQueue() was the third beacon call site and the only one that discarded the result.
  // Its boolean reflects storage removal, never delivery — so a blocked sendBeacon (routine with
  // analytics blockers, and the payload here is the whole unlocked queue, so the ~64KB cap applies
  // too) destroyed everything collected under valid consent, returned true, and logged nothing.
  // README promises a withdrawal drops the queue "without discarding data the user had agreed to".
  it('reports a blocked beacon when purging the queue on consent withdrawal', async () => {
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {})
    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 99, maxWaitMs: 99_999 })
    await t.send(evt('consented'))
    await t.send(cookielessEvt('ck'))
    beacon.mockReturnValue(false)

    expect(t.purgeQueue()).toBe(false)
    // The cookieless queue is memory-only, so its loss is permanent — error, not warn.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('cookieless'))
    errSpy.mockRestore()
  })

  // R2-S18: the !isStorageAvailable() arm of reportBeaconLoss was dead to the suite — making it
  // unreachable left 421/421 green. Without localStorage the consented queue is memory-backed too,
  // so "will retry on next init()" is false and the loss is permanent.
  it('escalates consented beacon loss to an error when localStorage is unavailable', async () => {
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {})
    // Spying on the *instance*, not Storage.prototype: a prototype spy never fires in this jsdom
    // environment, so isStorageAvailable() would keep returning true and the branch stay unreached.
    const setSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 99, maxWaitMs: 99_999 })
    await t.send(evt('consented'))
    beacon.mockReturnValue(false)

    window.dispatchEvent(new Event('pagehide'))

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('cannot be recovered'))
    setSpy.mockRestore()
    errSpy.mockRestore()
  })
})

describe('rollback messaging after a concurrent purge', () => {
  // If a flush is in flight when purgeQueue() runs, purge() empties the buffer and the in-flight
  // transient .catch then rolls back onto nothing — while logging "will retry". Nothing will retry;
  // those events are gone. The message actively misdescribed the outcome.
  it('does not claim a retry when the queue was purged mid-flight', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    let rejectSend: (err: unknown) => void = () => {}
    sendBatch.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject
        }),
    )

    const t = createBatchedTransport(ENDPOINT, KEY, freshProject(), { maxSize: 1, maxWaitMs: 50 })
    await t.send(evt('a')) // hits maxSize -> flush() -> in flight
    await vi.advanceTimersByTimeAsync(0)

    t.purgeQueue() // empties the buffer under the in-flight batch
    rejectSend(new RpcError('down', GrpcCode.Unavailable))
    await vi.advanceTimersByTimeAsync(10)

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('will retry'), expect.anything())
    warnSpy.mockRestore()
  })
})
