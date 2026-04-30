import {
  type PropertyValue,
  PropertyValueSchema,
} from '@buf/fivebits_cotton.bufbuild_es/common/v1/property_value_pb.js'
import { type Event, EventSchema } from '@buf/fivebits_cotton.bufbuild_es/sdk/events/v1/events_pb.js'
import { create, type DescMessage, type MessageInitShape, type MessageShape, ScalarType } from '@bufbuild/protobuf'
import { timestampFromMs, timestampNow } from '@bufbuild/protobuf/wkt'
import { createValidator } from '@bufbuild/protovalidate'
import { log } from './logger.js'
import { parseUserAgentData, parseUtmParams } from './parsers.js'
import { SDK_VERSION } from './version.js'
import { type JsonValue, type TrackOptions, type WellKnownEventName, wellKnownSchemas } from './well-known-events.js'

export type {
  JsonValue,
  TrackFn,
  TrackOptions,
  WellKnownEventName,
  WellKnownEventPropsMap,
} from './well-known-events.js'

const validator = createValidator()

// Proto-enforced cap: PropertyValue.string_value has (buf.validate.field).string.max_len = 1024.
// CEL's size(string) counts Unicode code points, so the validator does too. Strings longer
// than this would fail Event-level validation and drop the entire event.
const MAX_STRING_LEN = 1024

const codePointLength = (s: string): number => {
  let n = 0
  for (const _ of s) {
    void _
    n++
  }
  return n
}

const truncateToCodePoints = (s: string, max: number): string => {
  let n = 0
  let out = ''
  for (const cp of s) {
    if (n >= max) {
      break
    }
    out += cp
    n++
  }
  return out
}

const makeStringValue = (raw: string): PropertyValue => {
  let value = raw
  // UTF-16 length is an upper bound on code-point count, so use it as a cheap pre-check.
  if (raw.length > MAX_STRING_LEN && codePointLength(raw) > MAX_STRING_LEN) {
    log.warn(`Property string exceeds ${MAX_STRING_LEN} code points, truncating`)
    value = truncateToCodePoints(raw, MAX_STRING_LEN)
  }
  return create(PropertyValueSchema, { value: { case: 'stringValue', value } })
}

/**
 * Maps an untyped JS value to a PropertyValue oneof. Used for:
 *   - extras on a well-known event (keys not in the schema)
 *   - all properties on a custom (non-well-known) event
 *
 * Returns null when the value cannot be represented and the property should be
 * dropped (the event itself is still sent).
 */
const jsValueToPropertyValue = (v: unknown): PropertyValue | null => {
  if (v === null || v === undefined) {
    return null
  }
  if (typeof v === 'string') {
    return makeStringValue(v)
  }
  if (typeof v === 'boolean') {
    return create(PropertyValueSchema, { value: { case: 'boolValue', value: v } })
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      return null
    }
    if (Number.isInteger(v) && Number.isSafeInteger(v)) {
      return create(PropertyValueSchema, { value: { case: 'intValue', value: BigInt(v) } })
    }
    return create(PropertyValueSchema, { value: { case: 'doubleValue', value: v } })
  }
  if (typeof v === 'bigint') {
    return create(PropertyValueSchema, { value: { case: 'intValue', value: v } })
  }
  if (v instanceof Date) {
    const ms = v.getTime()
    if (!Number.isFinite(ms)) {
      return null
    }
    return create(PropertyValueSchema, { value: { case: 'timestampValue', value: timestampFromMs(ms) } })
  }
  if (typeof v === 'object') {
    let json: string
    try {
      json = JSON.stringify(v)
    } catch {
      return null
    }
    if (json === undefined) {
      return null
    }
    return makeStringValue(json)
  }
  return null
}

/**
 * Builds a PropertyValue for a known scalar field on a well-known event,
 * picking the oneof case from the field's proto scalar type rather than from
 * the JS value. This preserves the schema's int-vs-double distinction even
 * when the user passes an integer-valued double field.
 */
const scalarToPropertyValue = (v: unknown, scalar: ScalarType): PropertyValue | null => {
  switch (scalar) {
    case ScalarType.STRING:
      return create(PropertyValueSchema, { value: { case: 'stringValue', value: v as string } })
    case ScalarType.BOOL:
      return create(PropertyValueSchema, { value: { case: 'boolValue', value: v as boolean } })
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return create(PropertyValueSchema, { value: { case: 'doubleValue', value: v as number } })
    case ScalarType.INT32:
    case ScalarType.UINT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
    case ScalarType.FIXED32:
      return create(PropertyValueSchema, { value: { case: 'intValue', value: BigInt(v as number) } })
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
    case ScalarType.FIXED64:
      return create(PropertyValueSchema, {
        value: { case: 'intValue', value: typeof v === 'bigint' ? v : BigInt(v as number | string) },
      })
    default:
      // BYTES and any future scalar types we don't know how to map.
      return null
  }
}

/**
 * Validates properties for a well-known event against its protobuf schema.
 * Returns the constructed proto message plus any extras (keys not in the
 * schema) for downstream PropertyValue mapping. Returns null if validation
 * fails (event should be dropped).
 */
const validateWellKnownProps = <Desc extends DescMessage>(
  schema: Desc,
  kind: string,
  data: Record<string, unknown>
): { msg: MessageShape<Desc>; extras: Record<string, JsonValue> } | null => {
  const knownNames = new Set(schema.fields.map(f => f.localName))
  const knownData: Record<string, unknown> = {}
  const extras: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(data)) {
    if (knownNames.has(k)) {
      knownData[k] = v
    } else if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') {
      log.warn(`Extra property "${k}" on event "${kind}" has non-serializable type ${typeof v}, skipping`)
    } else {
      extras[k] = v as JsonValue
    }
  }

  let msg: MessageShape<Desc>
  try {
    msg = create(schema, knownData as MessageInitShape<Desc>)
  } catch (err) {
    log.error(`Event "${kind}" dropped: invalid properties for "${schema.typeName}":`, err)
    return null
  }

  const result = validator.validate(schema, msg)
  if (result.kind !== 'valid') {
    log.error(
      `Event "${kind}" dropped: properties validation failed for "${schema.typeName}":`,
      result.kind === 'invalid' ? result.violations.map(v => `${v.field}: ${v.message}`).join(', ') : result.error
    )
    return null
  }

  return { msg, extras }
}

/**
 * Walks a well-known event's typed message and builds the customProperties map
 * from its scalar fields. Skips fields holding their proto-default value to
 * mirror the canonical JSON behavior of implicit-presence scalars.
 */
const buildKnownPropertyMap = <Desc extends DescMessage>(
  schema: Desc,
  msg: MessageShape<Desc>
): Record<string, PropertyValue> => {
  const out: Record<string, PropertyValue> = {}
  for (const field of schema.fields) {
    if (field.fieldKind !== 'scalar') {
      continue
    }
    const v = (msg as unknown as Record<string, unknown>)[field.localName]
    if (v === '' || v === 0 || v === false || v === 0n) {
      continue
    }
    const pv = scalarToPropertyValue(v, field.scalar)
    if (pv) {
      out[field.localName] = pv
    }
  }
  return out
}

export const toEvent = (
  projectId: string,
  kind: string,
  sessionId: string,
  distinctId: string,
  props?: Record<string, unknown>,
  opts?: TrackOptions
): Event | null => {
  let customProperties: Record<string, PropertyValue> = {}

  if (kind in wellKnownSchemas) {
    const schema = wellKnownSchemas[kind as WellKnownEventName]
    const validated = validateWellKnownProps(schema, kind, props ?? {})
    if (validated === null) {
      return null
    }
    customProperties = buildKnownPropertyMap(schema, validated.msg)
    for (const [k, v] of Object.entries(validated.extras)) {
      const pv = jsValueToPropertyValue(v)
      if (pv) {
        customProperties[k] = pv
      }
    }
  } else if (props) {
    for (const [k, v] of Object.entries(props)) {
      const pv = jsValueToPropertyValue(v)
      if (pv) {
        customProperties[k] = pv
      }
    }
  }

  let event: Event
  try {
    event = create(EventSchema, {
      autoProperties: {
        $projectId: projectId,
        $url: window.location.href,
        $referrer: document.referrer,
        $locale: navigator.language,
        $screenWidth: String(window.screen.width),
        $screenHeight: String(window.screen.height),
        $pageTitle: document.title,
        $sdkVersion: SDK_VERSION,
        ...parseUserAgentData(),
        ...parseUtmParams(window.location.search),
      },
      customProperties,
      kind,
      sessionId,
      distinctId,
      occurTime: opts?.timestamp && Number.isFinite(opts.timestamp) ? timestampFromMs(opts.timestamp) : timestampNow(),
    })
  } catch (err) {
    log.error(`Event "${kind}" dropped: failed to create Event proto:`, err)
    return null
  }

  const result = validator.validate(EventSchema, event)
  if (result.kind !== 'valid') {
    const source = kind in wellKnownSchemas ? 'well-known' : 'custom'
    log.error(
      `Event "${kind}" (${source}) failed Event-level validation:`,
      result.kind === 'invalid' ? result.violations.map(v => `${v.field}: ${v.message}`).join(', ') : result.error
    )
    return null
  }

  return event
}
