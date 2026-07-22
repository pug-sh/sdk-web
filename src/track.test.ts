import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureBeforeSend, toEvent } from './track.js'

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

// Well-known event names are a compile-time typing affordance only — there is no runtime
// schema, so a well-known name serializes through the exact same JS heuristic as a custom
// event. These tests lock in that runtime behavior (esp. int-vs-double, which the backend
// coalesces — see docs/ and the sdk-web bundle-size work).
describe('well-known event names (runtime heuristic, no schema)', () => {
  it('serializes an integer on a well-known numeric field as intValue (schema no longer forces double)', () => {
    const ev = toEvent(
      PROJECT_ID,
      'purchase',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      {
        productId: 'sku-1',
        amount: 5,
        currency: 'USD',
      },
    )
    expect(ev).not.toBeNull()
    // 5 is a safe integer → intValue. The backend reads Int64 and Float64 slots together.
    expect(ev!.customProperties.amount?.value.case).toBe('intValue')
    expect(ev!.customProperties.amount?.value.value).toBe(5n)
    expect(ev!.customProperties.productId?.value.case).toBe('stringValue')
    expect(ev!.customProperties.currency?.value.case).toBe('stringValue')
  })

  it('serializes a fractional value on the same field as doubleValue', () => {
    const ev = toEvent(
      PROJECT_ID,
      'purchase',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      {
        productId: 'sku-1',
        amount: 5.5,
        currency: 'USD',
      },
    )
    expect(ev!.customProperties.amount?.value.case).toBe('doubleValue')
    expect(ev!.customProperties.amount?.value.value).toBe(5.5)
  })

  it('includes an explicitly passed 0 and maps only the keys the caller provided', () => {
    const ev = toEvent(
      PROJECT_ID,
      'scroll',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      { percent: 0, scrollY: 250 },
    )
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.percent?.value.case).toBe('intValue')
    expect(ev!.customProperties.percent?.value.value).toBe(0n)
    expect(ev!.customProperties.scrollY?.value.value).toBe(250n)
  })

  it('does not fabricate unset fields', () => {
    const ev = toEvent(PROJECT_ID, 'click', { sessionId: SESSION_ID, distinctId: DISTINCT_ID }, { tag: 'button' })
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.tag?.value.case).toBe('stringValue')
    expect(ev!.customProperties.id).toBeUndefined()
    expect(ev!.customProperties.text).toBeUndefined()
    expect(ev!.customProperties.x).toBeUndefined()
    expect(ev!.customProperties.y).toBeUndefined()
  })

  it('builds the event even when a value would violate a server-side constraint (server is the authority)', () => {
    const ev = toEvent(
      PROJECT_ID,
      'purchase',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      {
        productId: 'sku',
        amount: -1, // would violate double.gt = 0 server-side
        currency: 'USD',
      },
    )
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.amount?.value.case).toBe('intValue')
    expect(ev!.customProperties.amount?.value.value).toBe(-1n)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('serializes every provided prop — a well-known name gets no special-casing', () => {
    const ev = toEvent(
      PROJECT_ID,
      'click',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      { tag: 'button', extraNote: 'hello' },
    )
    expect(ev!.customProperties.tag?.value.case).toBe('stringValue')
    expect(ev!.customProperties.extraNote?.value.case).toBe('stringValue')
    expect(ev!.customProperties.extraNote?.value.value).toBe('hello')
  })

  it('warns per key on function/symbol values and silently drops undefined', () => {
    const ev = toEvent(
      PROJECT_ID,
      'click',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      {
        tag: 'button',
        cb: () => {},
        sym: Symbol('x'),
        gone: undefined,
      },
    )
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.tag?.value.case).toBe('stringValue')
    expect(ev!.customProperties.cb).toBeUndefined()
    expect(ev!.customProperties.sym).toBeUndefined()
    expect(ev!.customProperties.gone).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"cb" on event "click" not representable (function)'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"sym" on event "click" not representable (symbol)'))
    // `gone: undefined` is dropped silently (common + unactionable), same as custom events.
  })
})

describe('JS heuristic (custom events)', () => {
  it('maps bigint to intValue', () => {
    const ev = toEvent(
      PROJECT_ID,
      'my_event',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      { id: 9007199254740993n },
    )
    expect(ev!.customProperties.id?.value.case).toBe('intValue')
    expect(ev!.customProperties.id?.value.value).toBe(9007199254740993n)
  })

  it('maps Date to timestampValue', () => {
    const d = new Date('2026-01-15T10:30:00.000Z')
    const ev = toEvent(PROJECT_ID, 'my_event', { sessionId: SESSION_ID, distinctId: DISTINCT_ID }, { ts: d })
    expect(ev!.customProperties.ts?.value.case).toBe('timestampValue')
  })

  it.each([NaN, Infinity, -Infinity])('drops non-finite number %p, keeps event, warns', n => {
    const ev = toEvent(
      PROJECT_ID,
      'my_event',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      { weird: n, ok: 'kept' },
    )
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.weird).toBeUndefined()
    expect(ev!.customProperties.ok?.value.case).toBe('stringValue')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"weird" on event "my_event" not representable'))
  })

  it('drops Date(NaN) without dropping the event', () => {
    const ev = toEvent(
      PROJECT_ID,
      'my_event',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      { ts: new Date(NaN), ok: 'kept' },
    )
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.ts).toBeUndefined()
    expect(ev!.customProperties.ok).toBeDefined()
  })

  it('JSON-stringifies a plain object as stringValue', () => {
    const ev = toEvent(
      PROJECT_ID,
      'my_event',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      { meta: { a: 1, b: 'x' } },
    )
    expect(ev!.customProperties.meta?.value.case).toBe('stringValue')
    expect(ev!.customProperties.meta?.value.value).toBe('{"a":1,"b":"x"}')
  })

  it('drops circular structures, keeps event', () => {
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    const ev = toEvent(PROJECT_ID, 'my_event', { sessionId: SESSION_ID, distinctId: DISTINCT_ID }, { cyc, ok: 'kept' })
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.cyc).toBeUndefined()
    expect(ev!.customProperties.ok).toBeDefined()
  })

  it('drops object whose toJSON returns undefined', () => {
    const ev = toEvent(
      PROJECT_ID,
      'my_event',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      {
        weird: { toJSON: () => undefined },
        ok: 'kept',
      },
    )
    expect(ev!.customProperties.weird).toBeUndefined()
    expect(ev!.customProperties.ok).toBeDefined()
  })

  it('silently drops null and undefined (no warn)', () => {
    const ev = toEvent(
      PROJECT_ID,
      'my_event',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      { a: null, b: undefined, ok: 'kept' },
    )
    expect(ev!.customProperties.a).toBeUndefined()
    expect(ev!.customProperties.b).toBeUndefined()
    expect(ev!.customProperties.ok).toBeDefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('drops function and symbol values with per-key warn, keeps event', () => {
    const ev = toEvent(
      PROJECT_ID,
      'my_event',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      {
        fn: () => {},
        sym: Symbol(),
        ok: 'kept',
      },
    )
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.fn).toBeUndefined()
    expect(ev!.customProperties.sym).toBeUndefined()
    expect(ev!.customProperties.ok).toBeDefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"fn" on event "my_event" not representable (function)'),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"sym" on event "my_event" not representable (symbol)'),
    )
  })

  it('drops object containing bigint (JSON.stringify throws), keeps event', () => {
    // JSON.stringify({ id: 1n }) throws TypeError; jsValueToPropertyValue's catch returns null,
    // and the per-key warn fires at the call site.
    const ev = toEvent(
      PROJECT_ID,
      'my_event',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      { meta: { id: 1n }, ok: 'kept' },
    )
    expect(ev).not.toBeNull()
    expect(ev!.customProperties.meta).toBeUndefined()
    expect(ev!.customProperties.ok).toBeDefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"meta" on event "my_event" not representable'))
  })
})

describe('string truncation (UTF-8 bytes, not codepoints)', () => {
  it('truncates ASCII strings exceeding 1024 bytes', () => {
    const long = 'a'.repeat(2000)
    const ev = toEvent(PROJECT_ID, 'my_event', { sessionId: SESSION_ID, distinctId: DISTINCT_ID }, { notes: long })
    const v = ev!.customProperties.notes?.value as { value: string }
    expect(v.value).toHaveLength(1024)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds 1024 bytes, truncating'))
  })

  it('truncates emoji string at a UTF-8 sequence boundary (no broken surrogate)', () => {
    // '😀' is 4 UTF-8 bytes, 2 UTF-16 units. 257 × 4 = 1028 bytes, exceeds cap.
    // Truncation should produce 256 complete emoji = 1024 bytes.
    const ev = toEvent(
      PROJECT_ID,
      'my_event',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      { e: '😀'.repeat(257) },
    )
    const v = ev!.customProperties.e?.value as { value: string }
    expect(new TextEncoder().encode(v.value).byteLength).toBeLessThanOrEqual(1024)
    // Each emoji is exactly 2 UTF-16 units; if truncation split a surrogate pair, length would be odd.
    expect(v.value.length % 2).toBe(0)
  })

  it('does not truncate multi-byte strings under the cap', () => {
    const s = '€'.repeat(300) // 3 UTF-8 bytes each = 900 bytes
    const ev = toEvent(PROJECT_ID, 'my_event', { sessionId: SESSION_ID, distinctId: DISTINCT_ID }, { e: s })
    const v = ev!.customProperties.e?.value as { value: string }
    expect(v.value).toBe(s)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('truncates schema-driven string fields too (not just custom)', () => {
    // search.query passes through scalarToPropertyValue → makeStringValue, so the well-known
    // path should also truncate (this was the C2 bug being fixed).
    const ev = toEvent(
      PROJECT_ID,
      'search',
      { sessionId: SESSION_ID, distinctId: DISTINCT_ID },
      { query: 'a'.repeat(2000) },
    )
    const v = ev!.customProperties.query?.value as { value: string }
    expect(v.value).toHaveLength(1024)
  })
})

describe('opts.timestamp', () => {
  it('uses opts.timestamp for occurTime when finite', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', { sessionId: SESSION_ID, distinctId: DISTINCT_ID }, undefined, {
      timestamp: 1700000000000,
    })
    expect(Number(ev!.occurTime!.seconds)).toBe(1700000000)
  })

  it('falls back to current time when opts.timestamp is NaN', () => {
    const before = Date.now()
    const ev = toEvent(PROJECT_ID, 'my_event', { sessionId: SESSION_ID, distinctId: DISTINCT_ID }, undefined, {
      timestamp: NaN,
    })
    const after = Date.now()
    const ms = Number(ev!.occurTime!.seconds) * 1000
    expect(ms).toBeGreaterThanOrEqual(before - 1000)
    expect(ms).toBeLessThanOrEqual(after + 1000)
  })
})

describe('Event proto integrity', () => {
  it('generates a uuidv7 eventId', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', { sessionId: SESSION_ID, distinctId: DISTINCT_ID })
    expect(ev!.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('generates a fresh eventId each call', () => {
    const a = toEvent(PROJECT_ID, 'my_event', { sessionId: SESSION_ID, distinctId: DISTINCT_ID })
    const b = toEvent(PROJECT_ID, 'my_event', { sessionId: SESSION_ID, distinctId: DISTINCT_ID })
    expect(a!.eventId).not.toBe(b!.eventId)
  })

  it('includes auto-properties with $-prefixed keys', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', { sessionId: SESSION_ID, distinctId: DISTINCT_ID })
    expect(ev!.autoProperties.$projectId.value.value).toBe(PROJECT_ID)
    expect(ev!.autoProperties.$sdkVersion).toBeTruthy()
  })

  // Both directions pinned — asserting only the omission would pass if $pageTitle were dropped
  // entirely.
  describe('$pageTitle is page-view only', () => {
    beforeEach(() => {
      document.title = 'Invoice #4417 — Dana Okonkwo'
    })

    it('sends $pageTitle on page_view', () => {
      const ev = toEvent(PROJECT_ID, 'page_view', { sessionId: SESSION_ID, distinctId: DISTINCT_ID })
      expect(ev!.autoProperties.$pageTitle?.value.value).toBe('Invoice #4417 — Dana Okonkwo')
    })

    // Every kind an automatic tracker emits, plus a custom one.
    it.each([
      'click',
      'scroll',
      'form_start',
      'form_submit',
      'rage_click',
      'dead_click',
      'my_event',
    ])('omits $pageTitle on %s', kind => {
      const ev = toEvent(PROJECT_ID, kind, { sessionId: SESSION_ID, distinctId: DISTINCT_ID })
      expect(ev!.autoProperties.$pageTitle).toBeUndefined()
    })

    // The conditional spread must not swallow its siblings.
    it('still sends the other auto-properties on a non-page_view event', () => {
      const ev = toEvent(PROJECT_ID, 'click', { sessionId: SESSION_ID, distinctId: DISTINCT_ID })
      expect(ev!.autoProperties.$projectId.value.value).toBe(PROJECT_ID)
      expect(ev!.autoProperties.$platform.value.value).toBe('web')
      expect(ev!.autoProperties.$sdkVersion).toBeTruthy()
    })
  })

  // The backend promotes $platform into a dedicated events column and never derives it from the UA
  // header, so an omitted or non-"web" value silently empties every platform breakdown/filter.
  it('sets $platform to "web"', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', { sessionId: SESSION_ID, distinctId: DISTINCT_ID })
    expect(ev!.autoProperties.$platform.value.value).toBe('web')
  })

  it('sets sessionId and distinctId as top-level Event fields, not as customProperties', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', { sessionId: SESSION_ID, distinctId: DISTINCT_ID }, { x: 1 })
    expect(ev!.sessionId).toBe(SESSION_ID)
    expect(ev!.distinctId).toBe(DISTINCT_ID)
    expect(ev!.customProperties.sessionId).toBeUndefined()
    expect(ev!.customProperties.distinctId).toBeUndefined()
  })
})

describe('toEvent cookieless identity', () => {
  it('builds an identity-free event with the cookieless flag set', () => {
    const event = toEvent(PROJECT_ID, 'page_view', { cookieless: true })
    expect(event).not.toBeNull()
    expect(event?.cookieless).toBe(true)
    expect(event?.distinctId).toBe('')
    expect(event?.sessionId).toBe('')
  })

  it('builds a consented event exactly as before via the identity object', () => {
    const event = toEvent(PROJECT_ID, 'click', { sessionId: 's-1', distinctId: 'anon-1' })
    expect(event?.cookieless).toBe(false)
    expect(event?.sessionId).toBe('s-1')
    expect(event?.distinctId).toBe('anon-1')
  })
})

describe('beforeSend', () => {
  const ID = { sessionId: SESSION_ID, distinctId: DISTINCT_ID }
  const str = (pv: { value: { value: unknown } } | undefined) => pv?.value.value

  afterEach(() => {
    configureBeforeSend(undefined)
  })

  it('is a no-op when unconfigured', () => {
    const ev = toEvent(PROJECT_ID, 'my_event', ID, { a: 1 })
    expect(str(ev!.customProperties.a)).toBe(1n)
    expect(str(ev!.autoProperties.$projectId)).toBe(PROJECT_ID)
  })

  it('rewrites an auto-property', () => {
    document.title = 'Invoice #4417 — Dana Okonkwo'
    configureBeforeSend(e => {
      e.autoProperties.$pageTitle = 'REDACTED'
      return e
    })
    const ev = toEvent(PROJECT_ID, 'page_view', ID)
    expect(str(ev!.autoProperties.$pageTitle)).toBe('REDACTED')
  })

  it('rewrites, adds and deletes custom properties', () => {
    configureBeforeSend(e => {
      delete e.customProperties.ssn
      e.customProperties.email = 'redacted@example.com'
      e.customProperties.tier = 'gold'
      return e
    })
    const ev = toEvent(PROJECT_ID, 'signup', ID, { ssn: '123-45-6789', email: 'dana@x.com' })
    expect(ev!.customProperties.ssn).toBeUndefined()
    expect(str(ev!.customProperties.email)).toBe('redacted@example.com')
    expect(str(ev!.customProperties.tier)).toBe('gold')
  })

  // The mutable bags invite `e => { e.x = y }` with no return; that must not read as a drop.
  it('keeps in-place mutations when the hook returns nothing', () => {
    configureBeforeSend(e => {
      e.customProperties.masked = true
    })
    const ev = toEvent(PROJECT_ID, 'my_event', ID, { a: 1 })
    expect(ev).not.toBeNull()
    expect(str(ev!.customProperties.masked)).toBe(true)
    expect(str(ev!.customProperties.a)).toBe(1n)
  })

  it('drops the event on null, at debug level (an intentional drop is not a warning)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    configureBeforeSend(e => (e.kind === 'internal_ping' ? null : e))
    expect(toEvent(PROJECT_ID, 'internal_ping', ID)).toBeNull()
    expect(toEvent(PROJECT_ID, 'my_event', ID)).not.toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
    debugSpy.mockRestore()
  })

  // The bag the hook receives must be the one we send from. Rebuilding it from the arguments meant
  // a hook that replaced a bag and returned nothing had its redaction dropped and the raw original
  // sent — the one failure direction a privacy hook must never have.
  it('honors a replaced bag when the hook returns nothing', () => {
    configureBeforeSend(e => {
      ;(e as { autoProperties: Record<string, string> }).autoProperties = {
        ...e.autoProperties,
        $url: 'REDACTED',
      }
      ;(e as { customProperties: Record<string, unknown> }).customProperties = {}
    })
    const ev = toEvent(PROJECT_ID, 'my_event', ID, { ssn: '123-45-6789' })
    expect(str(ev!.autoProperties.$url)).toBe('REDACTED')
    expect(ev!.customProperties.ssn).toBeUndefined()
  })

  it('cannot reroute the event: kind is readonly and re-reading it after mutation is unsupported', () => {
    configureBeforeSend(e => {
      ;(e as { kind: string }).kind = 'spoofed'
      return e
    })
    const ev = toEvent(PROJECT_ID, 'my_event', ID)
    expect(ev!.kind).toBe('my_event')
  })

  describe('protected auto-properties survive the hook', () => {
    it.each(['$projectId', '$platform', '$sdkVersion'])('re-asserts %s after a hook deletes it', key => {
      configureBeforeSend(e => {
        delete e.autoProperties[key]
        return e
      })
      const ev = toEvent(PROJECT_ID, 'my_event', ID)
      expect(ev!.autoProperties[key]).toBeDefined()
    })

    it('re-asserts them after a hook overwrites them', () => {
      configureBeforeSend(e => {
        e.autoProperties.$projectId = 'other-project'
        e.autoProperties.$platform = 'ios'
        return e
      })
      const ev = toEvent(PROJECT_ID, 'my_event', ID)
      expect(str(ev!.autoProperties.$projectId)).toBe(PROJECT_ID)
      expect(str(ev!.autoProperties.$platform)).toBe('web')
    })

    it('survives a hook returning a wholly empty event', () => {
      configureBeforeSend(() => ({ kind: 'my_event', autoProperties: {}, customProperties: {} }))
      const ev = toEvent(PROJECT_ID, 'my_event', ID, { a: 1 })
      expect(str(ev!.autoProperties.$projectId)).toBe(PROJECT_ID)
      expect(str(ev!.autoProperties.$sdkVersion)).toBeTruthy()
      expect(ev!.customProperties.a).toBeUndefined()
    })
  })

  describe('fails closed', () => {
    it('drops the event when the hook throws, without leaking the error message', () => {
      configureBeforeSend(() => {
        throw new Error('dana@example.com was being redacted')
      })
      expect(toEvent(PROJECT_ID, 'my_event', ID)).toBeNull()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('beforeSend threw'), 'Error')
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('dana@example.com'), expect.anything())
    })

    it.each([42, 'nope', [] as unknown, { autoProperties: {} }])('drops the event on malformed return %p', bad => {
      configureBeforeSend(() => bad as never)
      expect(toEvent(PROJECT_ID, 'my_event', ID)).toBeNull()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('malformed event'))
    })

    // These pass a `typeof v === 'object'` check but yield nothing from Object.entries, so a laxer
    // guard sent a hollowed-out event — every property gone — with no warning at all.
    it.each([
      ['array bags', { autoProperties: [], customProperties: [] }],
      ['Map bags', { autoProperties: new Map([['$url', 'x']]), customProperties: new Map() }],
    ])('drops the event when the hook returns %s', (_label, bad) => {
      configureBeforeSend(() => bad as never)
      expect(toEvent(PROJECT_ID, 'my_event', ID)).toBeNull()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('malformed event'))
    })

    it('drops every event when configured with a non-function', () => {
      configureBeforeSend('not a function' as never)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('beforeSend must be a function'))
      expect(toEvent(PROJECT_ID, 'my_event', ID)).toBeNull()
    })

    it('warns once per configure, not once per event', () => {
      configureBeforeSend(() => {
        throw new Error('boom')
      })
      toEvent(PROJECT_ID, 'my_event', ID)
      toEvent(PROJECT_ID, 'my_event', ID)
      toEvent(PROJECT_ID, 'my_event', ID)
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    // Separate flags: sharing one meant a throw at page load silenced every later malformed return
    // for the life of the page, and vice versa.
    it('warns for a malformed return even after a throw already warned', () => {
      let mode: 'throw' | 'malformed' = 'throw'
      configureBeforeSend(() => {
        if (mode === 'throw') {
          throw new Error('boom')
        }
        return 42 as never
      })
      toEvent(PROJECT_ID, 'my_event', ID)
      mode = 'malformed'
      toEvent(PROJECT_ID, 'my_event', ID)

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('beforeSend threw'), 'Error')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('malformed event'))
    })
  })

  // The only route to URL masking now that sanitizeUrl is gone.
  it('can mask $url and $referrer', () => {
    configureBeforeSend(e => {
      e.autoProperties.$url = (e.autoProperties.$url as string).replace(/\/orders\/\d+/, '/orders/:id')
      return e
    })
    window.history.replaceState({}, '', '/orders/12345?q=1')
    const ev = toEvent(PROJECT_ID, 'my_event', ID)
    expect(str(ev!.autoProperties.$url)).toContain('/orders/:id')
    expect(str(ev!.autoProperties.$url)).not.toContain('12345')
  })

  it('is cleared by configureBeforeSend(undefined)', () => {
    configureBeforeSend(() => null)
    expect(toEvent(PROJECT_ID, 'my_event', ID)).toBeNull()
    configureBeforeSend(undefined)
    expect(toEvent(PROJECT_ID, 'my_event', ID)).not.toBeNull()
  })
})
