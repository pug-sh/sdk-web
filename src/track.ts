import { type PropertyValue, PropertyValueSchema } from '@buf/fivebits_pug.bufbuild_es/common/v1/property_value_pb.js'
import { type Event, EventSchema } from '@buf/fivebits_pug.bufbuild_es/sdk/events/v1/events_pb.js'
import { create, type DescMessage, type MessageInitShape, type MessageShape, ScalarType } from '@bufbuild/protobuf'
import { reflect, type ScalarValue } from '@bufbuild/protobuf/reflect'
import { timestampFromMs, timestampNow } from '@bufbuild/protobuf/wkt'
import { createValidator } from '@bufbuild/protovalidate'
import { uuidv7 } from 'uuidv7'
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

let urlSanitizer: ((url: string) => string) | null = null

// Sanitizer failures are logged once per init() (the flag resets in configureUrlSanitizer) so a
// sanitizer that fails on every event can't bury the "you're losing all your URLs" signal in spam.
let sanitizerFailureWarned = false

/**
 * Sets the URL sanitizer applied to `$url`, `$referrer`, and captured form actions before they
 * leave the device. Wired up from `init({ sanitizeUrl })`; pass `undefined` to clear it (done on
 * `destroy()`). A non-function value is a bug — the type forbids it, but a JS caller can slip one
 * in. Because passing *something* signals intent to sanitize, we fail closed: every URL field is
 * dropped (sanitized to `''`) rather than leaking raw URLs the caller believed were being redacted.
 */
export const configureUrlSanitizer = (fn?: (url: string) => string): void => {
  if (fn !== undefined && typeof fn !== 'function') {
    log.warn('sanitizeUrl must be a function; dropping URL fields to avoid leaking unsanitized data.')
    urlSanitizer = () => ''
  } else {
    urlSanitizer = fn ?? null
  }
  sanitizerFailureWarned = false
}

/**
 * Runs `url` through the configured sanitizer, returning the raw URL when none is set. An empty
 * string is returned as-is without calling the sanitizer: there is nothing to redact, and handing
 * `''` to a base-relative sanitizer would let it fabricate a URL (e.g. resolve to the page origin),
 * corrupting a referrer-less `$referrer`.
 *
 * Fails closed: if the sanitizer throws or returns a non-string, the URL is dropped to an empty
 * string rather than the raw value — a buggy sanitizer must not leak the PII it was meant to strip.
 * Never throws, so it is safe to call from the always-safe `track()` path.
 */
export const sanitizeUrlValue = (url: string): string => {
  if (!url || !urlSanitizer) {
    return url
  }
  try {
    const result = urlSanitizer(url)
    if (typeof result !== 'string') {
      warnSanitizerFailure('sanitizeUrl returned a non-string value; dropping URL to avoid leaking unsanitized data.')
      return ''
    }
    return result
  } catch (err) {
    // Log the error type only, never the error itself — a sanitizer that interpolates the URL into
    // its message would otherwise re-surface the PII it was meant to strip into client-side logs.
    warnSanitizerFailure(
      'sanitizeUrl threw; dropping URL to avoid leaking unsanitized data. Error type:',
      err instanceof Error ? err.name : typeof err,
    )
    return ''
  }
}

const warnSanitizerFailure = (msg: string, ...args: unknown[]): void => {
  if (sanitizerFailureWarned) {
    return
  }
  sanitizerFailureWarned = true
  log.warn(msg, ...args)
}

const isWellKnownEvent = (kind: string): kind is WellKnownEventName => kind in wellKnownSchemas

// Truncate by UTF-8 byte length to stay under proto's `string.max_len = 1024`.
// protovalidate counts code points, not bytes, so byte truncation is strictly more
// conservative — a string ≤ 1024 bytes is always ≤ 1024 codepoints (one codepoint is
// 1–4 UTF-8 bytes).
const MAX_STRING_BYTES = 1024

const utf8ByteLength = (s: string): number => new TextEncoder().encode(s).byteLength

const truncateToBytes = (s: string, max: number): string => {
  const bytes = new TextEncoder().encode(s)
  if (bytes.byteLength <= max) {
    return s
  }
  // Step back from the cut to a UTF-8 leading byte (high two bits != 10).
  let cut = max
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) {
    cut--
  }
  return new TextDecoder().decode(bytes.subarray(0, cut))
}

const makeStringValue = (raw: string): PropertyValue => {
  let value = raw
  // Each UTF-16 code unit is at most 3 UTF-8 bytes (BMP) or shares a 4-byte sequence
  // with another unit (supplementary). length * 3 is therefore a strict upper bound,
  // letting most strings skip the TextEncoder allocation.
  if (raw.length * 3 > MAX_STRING_BYTES && utf8ByteLength(raw) > MAX_STRING_BYTES) {
    log.warn(`Property string exceeds ${MAX_STRING_BYTES} bytes, truncating`)
    value = truncateToBytes(raw, MAX_STRING_BYTES)
  }
  return create(PropertyValueSchema, { value: { case: 'stringValue', value } })
}

/**
 * Maps an untyped JS value to a PropertyValue oneof. Used for:
 *   - extras on a well-known event (keys not in the schema)
 *   - all properties on a custom (non-well-known) event
 *
 * Returns null when the value cannot be represented; the caller is responsible for
 * omitting the property from the map.
 *
 * Mapping:
 *   - string         → stringValue (truncated to 1024 UTF-8 bytes if needed)
 *   - boolean        → boolValue
 *   - number         → intValue when Number.isSafeInteger, else doubleValue;
 *                      NaN/±Infinity dropped (the validator rejects non-finite doubles)
 *   - bigint         → intValue
 *   - Date           → timestampValue (Date(NaN) dropped)
 *   - object/array   → JSON.stringify → stringValue (subject to truncation);
 *                      circular structures and toJSON returning undefined dropped
 *   - null/undefined → dropped (no oneof case fits)
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
    if (Number.isSafeInteger(v)) {
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
 * Builds a PropertyValue for a known scalar field on a well-known event, picking the
 * oneof case from the field's proto scalar type rather than from the JS value. This
 * preserves the schema's int-vs-double distinction even when the user passes an
 * integer-valued double field.
 *
 * Returns `null` for `BYTES`, any scalar type not enumerated here, and any value whose
 * runtime type doesn't match the scalar (defense in depth — protovalidate already enforces
 * the type contract upstream, but the guards keep this function honest for direct callers
 * and future schema bumps). Callers must guard against `null`.
 */
const scalarToPropertyValue = (v: ScalarValue, scalar: ScalarType): PropertyValue | null => {
  switch (scalar) {
    case ScalarType.STRING:
      return typeof v === 'string' ? makeStringValue(v) : null
    case ScalarType.BOOL:
      return typeof v === 'boolean' ? create(PropertyValueSchema, { value: { case: 'boolValue', value: v } }) : null
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return typeof v === 'number' ? create(PropertyValueSchema, { value: { case: 'doubleValue', value: v } }) : null
    case ScalarType.INT32:
    case ScalarType.UINT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
    case ScalarType.FIXED32:
      return typeof v === 'number' && Number.isSafeInteger(v)
        ? create(PropertyValueSchema, { value: { case: 'intValue', value: BigInt(v) } })
        : null
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
    case ScalarType.FIXED64:
      return typeof v === 'bigint' ? create(PropertyValueSchema, { value: { case: 'intValue', value: v } }) : null
    default:
      // BYTES and any future scalar types we don't know how to map.
      return null
  }
}

type WellKnownValidation<Desc extends DescMessage> =
  | { ok: true; msg: MessageShape<Desc>; extras: Record<string, JsonValue> }
  | { ok: false }

/**
 * Validates properties for a well-known event against its protobuf schema.
 *
 * Returns the constructed proto message plus any extras (keys not in the schema). Extras
 * with non-serializable types (`undefined`, `function`, `symbol`) are dropped here with a
 * warn log; everything else passes through to PropertyValue mapping downstream.
 *
 * Returns `{ ok: false }` if `create()` throws or protovalidate rejects the message.
 */
const validateWellKnownProps = <Desc extends DescMessage>(
  schema: Desc,
  kind: string,
  data: Record<string, unknown>,
): WellKnownValidation<Desc> => {
  const knownNames = new Set(schema.fields.map(f => f.localName))
  const knownData: Record<string, unknown> = {}
  const extras: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(data)) {
    if (knownNames.has(k)) {
      knownData[k] = v
    } else if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
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
    return { ok: false }
  }

  const result = validator.validate(schema, msg)
  if (result.kind !== 'valid') {
    log.error(
      `Event "${kind}" dropped: properties validation failed for "${schema.typeName}":`,
      result.kind === 'invalid' ? result.violations.map(v => `${v.field}: ${v.message}`).join(', ') : result.error,
    )
    return { ok: false }
  }

  return { ok: true, msg, extras }
}

/**
 * Walks a well-known event's typed message and builds the customProperties map from its
 * scalar fields. Uses reflection to honor explicit field presence — only set fields are
 * included, so an unset `scrollY` is skipped while an explicit `scrollY: 0` is sent.
 *
 * Logs a warn for any non-scalar field or unsupported scalar type, since today's
 * well-known schemas only use scalars and the moment one doesn't, the maintainer
 * needs a loud signal at SDK-bump time.
 */
const buildKnownPropertyMap = <Desc extends DescMessage>(
  schema: Desc,
  msg: MessageShape<Desc>,
): Record<string, PropertyValue> => {
  const out: Record<string, PropertyValue> = {}
  const r = reflect(schema, msg, false)
  for (const field of schema.fields) {
    if (field.fieldKind !== 'scalar') {
      log.warn(`Field "${schema.typeName}.${field.localName}" has unsupported fieldKind "${field.fieldKind}", skipping`)
      continue
    }
    if (!r.isSet(field)) {
      continue
    }
    const v = r.get(field)
    const pv = scalarToPropertyValue(v, field.scalar)
    if (pv) {
      out[field.localName] = pv
    } else {
      log.warn(
        `Field "${schema.typeName}.${field.localName}" has unsupported scalar type ${ScalarType[field.scalar]}, skipping`,
      )
    }
  }
  return out
}

const mapPropsViaHeuristic = (
  source: Record<string, unknown>,
  customProperties: Record<string, PropertyValue>,
  kind: string,
): void => {
  for (const [k, v] of Object.entries(source)) {
    const pv = jsValueToPropertyValue(v)
    if (pv) {
      customProperties[k] = pv
    } else if (v !== null && v !== undefined) {
      log.warn(`Property "${k}" on event "${kind}" not representable (${typeof v}), skipping`)
    }
  }
}

const mapObjectValuesViaHeuristic = <T>(
  source: Record<string, T>,
  transform: (value: T) => PropertyValue,
): Record<string, PropertyValue> => {
  const result: Record<string, PropertyValue> = {}
  for (const [k, v] of Object.entries(source)) {
    result[k] = transform(v)
  }
  return result
}

export const toEvent = (
  projectId: string,
  kind: string,
  sessionId: string,
  distinctId: string,
  props?: Record<string, unknown>,
  opts?: TrackOptions,
): Event | null => {
  let customProperties: Record<string, PropertyValue> = {}

  if (isWellKnownEvent(kind)) {
    const schema = wellKnownSchemas[kind]
    const validated = validateWellKnownProps(schema, kind, props ?? {})
    if (!validated.ok) {
      return null
    }
    customProperties = buildKnownPropertyMap(schema, validated.msg)
    mapPropsViaHeuristic(validated.extras, customProperties, kind)
  } else if (props) {
    mapPropsViaHeuristic(props, customProperties, kind)
  }

  let event: Event
  try {
    event = create(EventSchema, {
      eventId: uuidv7(),
      autoProperties: {
        $projectId: makeStringValue(projectId),
        $url: makeStringValue(sanitizeUrlValue(window.location.href)),
        $referrer: makeStringValue(sanitizeUrlValue(document.referrer)),
        $locale: makeStringValue(navigator.language),
        $screenWidth: makeStringValue(String(window.screen.width)),
        $screenHeight: makeStringValue(String(window.screen.height)),
        $pageTitle: makeStringValue(document.title),
        $sdkVersion: makeStringValue(SDK_VERSION),
        ...mapObjectValuesViaHeuristic(
          {
            ...parseUserAgentData(),
            ...parseUtmParams(window.location.search),
          },
          makeStringValue,
        ),
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
    const source = isWellKnownEvent(kind) ? 'well-known' : 'custom'
    log.error(
      `Event "${kind}" (${source}) failed Event-level validation:`,
      result.kind === 'invalid' ? result.violations.map(v => `${v.field}: ${v.message}`).join(', ') : result.error,
    )
    return null
  }

  return event
}
