import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toEvent } from './track.js'

const PROJECT_ID = 'test-project'
const SESSION_ID = '01234567-0123-7123-8123-012345678901'
const DISTINCT_ID = 'anon-01234567-0123-7123-8123-012345678901'

let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('schema-driven path (well-known events)', () => {
  it('preserves int-vs-double schema intent: integer JS number on double field → doubleValue', () => {
    const ev = toEvent(PROJECT_ID, 'purchase', SESSION_ID, DISTINCT_ID, {
      productId: 'sku-1',
      amount: 5,
      currency: 'USD',
    })
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.amount?.value.case).toBe('doubleValue')
    expect(ev!.customProperties.amount?.value.value).toBe(5)
    expect(ev!.customProperties.productId?.value.case).toBe('stringValue')
    expect(ev!.customProperties.currency?.value.case).toBe('stringValue')
  })

  it('preserves explicitly set 0 on int32 field (explicit presence via reflect.isSet)', () => {
    const ev = toEvent(PROJECT_ID, 'scroll', SESSION_ID, DISTINCT_ID, { percent: 0, scrollY: 250 })
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.percent?.value.case).toBe('intValue')
    expect(ev!.customProperties.percent?.value.value).toBe(0n)
    expect(ev!.customProperties.scrollY?.value.value).toBe(250n)
  })

  it('omits unset optional fields from customProperties', () => {
    const ev = toEvent(PROJECT_ID, 'click', SESSION_ID, DISTINCT_ID, { tag: 'button' })
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.tag?.value.case).toBe('stringValue')
    expect(ev!.customProperties.id).toBeUndefined()
    expect(ev!.customProperties.text).toBeUndefined()
    expect(ev!.customProperties.x).toBeUndefined()
    expect(ev!.customProperties.y).toBeUndefined()
  })

  it('drops the entire event when a known field violates schema constraints', () => {
    const ev = toEvent(PROJECT_ID, 'purchase', SESSION_ID, DISTINCT_ID, {
      productId: 'sku',
      amount: -1, // violates double.gt = 0
      currency: 'USD',
    })
    expect(ev).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('properties validation failed'), expect.anything())
  })

  it('passes extras (unknown keys) through the JS heuristic', () => {
    const ev = toEvent(PROJECT_ID, 'click', SESSION_ID, DISTINCT_ID, { tag: 'button', extraNote: 'hello' })
    expect(ev!.customProperties.tag?.value.case).toBe('stringValue')
    expect(ev!.customProperties.extraNote?.value.case).toBe('stringValue')
    expect(ev!.customProperties.extraNote?.value.value).toBe('hello')
  })

  it('drops extras with non-serializable types (function/symbol/undefined) and warns per key', () => {
    const ev = toEvent(PROJECT_ID, 'click', SESSION_ID, DISTINCT_ID, {
      tag: 'button',
      cb: () => {},
      sym: Symbol('x'),
      gone: undefined,
    })
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.tag?.value.case).toBe('stringValue')
    expect(ev!.customProperties.cb).toBeUndefined()
    expect(ev!.customProperties.sym).toBeUndefined()
    expect(ev!.customProperties.gone).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Extra property "cb" on event "click" has non-serializable type function')
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Extra property "sym" on event "click" has non-serializable type symbol')
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Extra property "gone" on event "click" has non-serializable type undefined')
    )
  })
})

describe('JS heuristic (custom events)', () => {
  it('maps bigint to intValue', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, { id: 9007199254740993n })
    expect(ev!.customProperties.id?.value.case).toBe('intValue')
    expect(ev!.customProperties.id?.value.value).toBe(9007199254740993n)
  })

  it('maps Date to timestampValue', () => {
    const d = new Date('2026-01-15T10:30:00.000Z')
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, { ts: d })
    expect(ev!.customProperties.ts?.value.case).toBe('timestampValue')
  })

  it.each([NaN, Infinity, -Infinity])('drops non-finite number %p, keeps event, warns', n => {
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, { weird: n, ok: 'kept' })
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.weird).toBeUndefined()
    expect(ev!.customProperties.ok?.value.case).toBe('stringValue')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"weird" on event "my_event" not representable'))
  })

  it('drops Date(NaN) without dropping the event', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, { ts: new Date(NaN), ok: 'kept' })
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.ts).toBeUndefined()
    expect(ev!.customProperties.ok).toBeDefined()
  })

  it('JSON-stringifies a plain object as stringValue', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, { meta: { a: 1, b: 'x' } })
    expect(ev!.customProperties.meta?.value.case).toBe('stringValue')
    expect(ev!.customProperties.meta?.value.value).toBe('{"a":1,"b":"x"}')
  })

  it('drops circular structures, keeps event', () => {
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, { cyc, ok: 'kept' })
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.cyc).toBeUndefined()
    expect(ev!.customProperties.ok).toBeDefined()
  })

  it('drops object whose toJSON returns undefined', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, {
      weird: { toJSON: () => undefined },
      ok: 'kept',
    })
    expect(ev!.customProperties.weird).toBeUndefined()
    expect(ev!.customProperties.ok).toBeDefined()
  })

  it('silently drops null and undefined (no warn)', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, { a: null, b: undefined, ok: 'kept' })
    expect(ev!.customProperties.a).toBeUndefined()
    expect(ev!.customProperties.b).toBeUndefined()
    expect(ev!.customProperties.ok).toBeDefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('drops function and symbol values with per-key warn, keeps event', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, {
      fn: () => {},
      sym: Symbol(),
      ok: 'kept',
    })
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.fn).toBeUndefined()
    expect(ev!.customProperties.sym).toBeUndefined()
    expect(ev!.customProperties.ok).toBeDefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"fn" on event "my_event" not representable (function)')
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"sym" on event "my_event" not representable (symbol)')
    )
  })

  it('drops object containing bigint (JSON.stringify throws), keeps event', () => {
    // JSON.stringify({ id: 1n }) throws TypeError; jsValueToPropertyValue's catch returns null,
    // and the per-key warn fires at the call site.
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, { meta: { id: 1n }, ok: 'kept' })
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.meta).toBeUndefined()
    expect(ev!.customProperties.ok).toBeDefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"meta" on event "my_event" not representable'))
  })
})

describe('string truncation (UTF-8 bytes, not codepoints)', () => {
  it('truncates ASCII strings exceeding 1024 bytes', () => {
    const long = 'a'.repeat(2000)
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, { notes: long })
    const v = ev!.customProperties.notes?.value as { value: string }
    expect(v.value).toHaveLength(1024)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds 1024 bytes, truncating'))
  })

  it('truncates emoji string at a UTF-8 sequence boundary (no broken surrogate)', () => {
    // '😀' is 4 UTF-8 bytes, 2 UTF-16 units. 257 × 4 = 1028 bytes, exceeds cap.
    // Truncation should produce 256 complete emoji = 1024 bytes.
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, { e: '😀'.repeat(257) })
    const v = ev!.customProperties.e?.value as { value: string }
    expect(new TextEncoder().encode(v.value).byteLength).toBeLessThanOrEqual(1024)
    // Each emoji is exactly 2 UTF-16 units; if truncation split a surrogate pair, length would be odd.
    expect(v.value.length % 2).toBe(0)
  })

  it('does not truncate multi-byte strings under the cap', () => {
    const s = '€'.repeat(300) // 3 UTF-8 bytes each = 900 bytes
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, { e: s })
    const v = ev!.customProperties.e?.value as { value: string }
    expect(v.value).toBe(s)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('truncates schema-driven string fields too (not just custom)', () => {
    // search.query passes through scalarToPropertyValue → makeStringValue, so the well-known
    // path should also truncate (this was the C2 bug being fixed).
    const ev = toEvent(PROJECT_ID, 'search', SESSION_ID, DISTINCT_ID, { query: 'a'.repeat(2000) })
    const v = ev!.customProperties.query?.value as { value: string }
    expect(v.value).toHaveLength(1024)
  })
})

describe('opts.timestamp', () => {
  it('uses opts.timestamp for occurTime when finite', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, undefined, { timestamp: 1700000000000 })
    expect(Number(ev!.occurTime!.seconds)).toBe(1700000000)
  })

  it('falls back to current time when opts.timestamp is NaN', () => {
    const before = Date.now()
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, undefined, { timestamp: NaN })
    const after = Date.now()
    const ms = Number(ev!.occurTime!.seconds) * 1000
    expect(ms).toBeGreaterThanOrEqual(before - 1000)
    expect(ms).toBeLessThanOrEqual(after + 1000)
  })
})

describe('Event proto integrity', () => {
  it('generates a uuidv7 eventId', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID)
    expect(ev!.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('generates a fresh eventId each call', () => {
    const a = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID)
    const b = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID)
    expect(a!.eventId).not.toBe(b!.eventId)
  })

  it('includes auto-properties with $-prefixed keys', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID)
    expect(ev!.autoProperties.$projectId.value.value).toBe(PROJECT_ID)
    expect(ev!.autoProperties.$sdkVersion).toBeTruthy()
  })

  it('sets sessionId and distinctId as top-level Event fields, not as customProperties', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', SESSION_ID, DISTINCT_ID, { x: 1 })
    expect(ev!.sessionId).toBe(SESSION_ID)
    expect(ev!.distinctId).toBe(DISTINCT_ID)
    expect(ev!.customProperties.sessionId).toBeUndefined()
    expect(ev!.customProperties.distinctId).toBeUndefined()
  })
})
