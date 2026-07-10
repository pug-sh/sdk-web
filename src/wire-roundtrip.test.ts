import { create, equals, fromBinary, toBinary } from '@bufbuild/protobuf'
import { timestampFromMs } from '@bufbuild/protobuf/wkt'
import { describe, expect, it } from 'vitest'
import { PropertyValueSchema } from './gen/common/v1/property_value_pb.js'
import { SubscribeRequestSchema } from './gen/sdk/devices/v1/devices_pb.js'
import { BatchCreateRequestSchema, EventSchema } from './gen/sdk/events/v1/events_pb.js'
import { IdentifyRequestSchema } from './gen/sdk/profiles/v1/profiles_pb.js'

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
