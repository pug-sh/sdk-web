import { create, equals, fromBinary, toBinary } from '@bufbuild/protobuf'
import { reflect } from '@bufbuild/protobuf/reflect'
import { timestampFromMs } from '@bufbuild/protobuf/wkt'
import { describe, expect, it } from 'vitest'
import { PropertyValueSchema } from './gen/common/v1/property_value_pb.js'
import { SubscribeRequestSchema } from './gen/sdk/devices/v1/devices_pb.js'
import { BatchCreateRequestSchema, type Event, EventSchema } from './gen/sdk/events/v1/events_pb.js'
import { IdentifyRequestSchema } from './gen/sdk/profiles/v1/profiles_pb.js'
import { toEvent } from './track.js'

/**
 * Which identity fields are actually *set* on the message. This proto is edition 2023, so these
 * fields have explicit presence and "set to empty string" is a different wire encoding from
 * "omitted" — which is precisely the distinction the server relies on, and precisely what a byte
 * -length threshold cannot express.
 */
const identityFieldsOnWire = (event: Event): string[] => {
  const r = reflect(EventSchema, event)
  return (['distinctId', 'sessionId'] as const).filter(name => r.isSet(EventSchema.field[name]))
}

// Regression guard for scripts/strip-validate-deps.mjs: the buf/validate descriptor is
// dropped from the generated deps arrays, leaving the `(buf.validate.*)` field options as
// unresolved unknown fields in the embedded descriptors. These round-trips prove that
// create()/toBinary()/fromBinary() on every message the SDK actually sends still work and
// are byte-stable, so serialization is unaffected by the missing extension type.
const roundTrips = <D extends Parameters<typeof create>[0]>(schema: D, init: Parameters<typeof create>[1]) => {
  const msg = create(schema, init)
  const bytes = toBinary(schema, msg)
  const back = fromBinary(schema, bytes)
  // Re-encoding the decoded message must produce identical bytes.
  expect(toBinary(schema, back)).toEqual(bytes)
  expect(equals(schema, msg, back)).toBe(true)
  return { msg, back, bytes }
}

describe('wire round-trip (validate deps stripped)', () => {
  it('PropertyValue round-trips every oneof case', () => {
    const cases = [
      { value: { case: 'stringValue', value: 'héllo 🚀' } },
      { value: { case: 'intValue', value: 9007199254740993n } },
      { value: { case: 'doubleValue', value: 3.14159 } },
      { value: { case: 'boolValue', value: true } },
      { value: { case: 'timestampValue', value: timestampFromMs(1_700_000_000_000) } },
    ] as const
    for (const init of cases) {
      const { back } = roundTrips(PropertyValueSchema, init)
      expect(back.value.case).toBe(init.value.case)
    }
  })

  it('Event round-trips with custom + auto properties (the string.max_len=1024 field carries a buf.validate option)', () => {
    const { back } = roundTrips(EventSchema, {
      eventId: '01234567-0123-7123-8123-012345678901',
      kind: 'purchase',
      sessionId: 'sess-1',
      distinctId: 'anon-1',
      occurTime: timestampFromMs(1_700_000_000_000),
      autoProperties: {
        $url: create(PropertyValueSchema, { value: { case: 'stringValue', value: 'https://x.test/p' } }),
      },
      customProperties: {
        amount: create(PropertyValueSchema, { value: { case: 'intValue', value: 5n } }),
        currency: create(PropertyValueSchema, { value: { case: 'stringValue', value: 'USD' } }),
      },
    })
    expect(back.kind).toBe('purchase')
    expect(back.customProperties.amount?.value.value).toBe(5n)
  })

  it('Event cookieless flag round-trips with identity omitted', () => {
    const { back } = roundTrips(EventSchema, { eventId: 'e2', kind: 'page_view', cookieless: true })
    expect(back.cookieless).toBe(true)
    expect(back.distinctId).toBe('')
    expect(back.sessionId).toBe('')
    expect(identityFieldsOnWire(back)).toEqual([])
  })

  // This proto is `edition = "2023"`, so presence is EXPLICIT: setting sessionId to '' emits the
  // field (length-delimited, zero length) while omitting it emits nothing at all. protovalidate
  // then applies `string.uuid` to the *set* empty string and rejects it — and because the batch
  // rule is a message-level CEL with .all(), one such event fails a batch of up to 1000.
  //
  // The previous guard for this was `expect(bytes.length).toBeLessThan(40)`, which passed for the
  // good encoding (9 B) AND the bad one (13 B), and would have failed outright against a real
  // toEvent() output (263 B — auto-properties plus a uuidv7 eventId). It was calibrated to a
  // synthetic fixture rather than to the invariant, so it could neither catch the regression nor
  // be pointed at real output.
  it('a sent-empty identity is distinguishable from an omitted one (the failure being guarded)', () => {
    const omitted = create(EventSchema, { eventId: 'e2', kind: 'page_view', cookieless: true })
    const sentEmpty = create(EventSchema, {
      eventId: 'e2',
      kind: 'page_view',
      cookieless: true,
      sessionId: '',
      distinctId: '',
    })
    expect(identityFieldsOnWire(omitted)).toEqual([])
    expect(identityFieldsOnWire(sentEmpty)).toEqual(['distinctId', 'sessionId'])
    expect(toBinary(EventSchema, omitted).length).toBeLessThan(toBinary(EventSchema, sentEmpty).length)
  })

  // Nothing else connects toEvent() to the wire: wire-roundtrip hand-built its events with create()
  // and track.test.ts only inspects the in-memory object. So the one function that actually decides
  // whether identity is omitted was never serialized in a test.
  it('toEvent() emits a real cookieless event with no identity fields on the wire', () => {
    const event = toEvent('proj-wire', 'page_view', { cookieless: true })
    expect(event).not.toBeNull()
    const back = fromBinary(EventSchema, toBinary(EventSchema, event as Event))
    expect(back.cookieless).toBe(true)
    expect(identityFieldsOnWire(back)).toEqual([])
  })

  it('toEvent() emits both identity fields for a consented event', () => {
    const event = toEvent('proj-wire', 'page_view', { sessionId: 'sess-1', distinctId: 'anon-1' })
    const back = fromBinary(EventSchema, toBinary(EventSchema, event as Event))
    expect(back.cookieless).toBe(false)
    expect(identityFieldsOnWire(back)).toEqual(['distinctId', 'sessionId'])
  })

  it('BatchCreateRequest round-trips (the RPC the transport actually sends)', () => {
    const event = create(EventSchema, { eventId: 'e1', kind: 'click', sessionId: 's', distinctId: 'd' })
    const { back } = roundTrips(BatchCreateRequestSchema, { events: [event] })
    expect(back.events).toHaveLength(1)
    expect(back.events[0].kind).toBe('click')
  })

  it('IdentifyRequest round-trips', () => {
    const { back } = roundTrips(IdentifyRequestSchema, { externalId: 'user-1', anonymousId: 'anon-1' })
    expect(back.externalId).toBe('user-1')
  })

  it('SubscribeRequest round-trips', () => {
    const { back } = roundTrips(SubscribeRequestSchema, { deviceId: 'dev-1', platform: 'web', token: 'tok' })
    expect(back.deviceId).toBe('dev-1')
  })
})
