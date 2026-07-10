import { create } from '@bufbuild/protobuf'
import { timestampFromMs, timestampNow } from '@bufbuild/protobuf/wkt'
import { uuidv7 } from 'uuidv7'
import { type PropertyValue, PropertyValueSchema } from './gen/common/v1/property_value_pb.js'
import { type Event, EventSchema } from './gen/sdk/events/v1/events_pb.js'
import { log } from './logger.js'
import { parseUserAgentData, parseUtmParams } from './parsers.js'
import { SDK_VERSION } from './version.js'
import type { TrackOptions } from './well-known-events.js'

export type {
  JsonValue,
  TrackFn,
  TrackOptions,
  WellKnownEventName,
  WellKnownEventPropsMap,
} from './well-known-events.js'

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

// Truncate by UTF-8 byte length to stay under the proto's `string.max_len = 1024`, which
// the server enforces as a code-point count, so byte truncation is strictly more
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
 * Maps an untyped JS value to a PropertyValue oneof. Every property on every event —
 * well-known or custom — flows through here; there is no runtime schema, so well-known
 * names carry no special serialization (the well-known typing is compile-time only).
 *
 * Returns null when the value cannot be represented; the caller is responsible for
 * omitting the property from the map.
 *
 * Mapping:
 *   - string         → stringValue (truncated to 1024 UTF-8 bytes if needed)
 *   - boolean        → boolValue
 *   - number         → intValue when Number.isSafeInteger, else doubleValue;
 *                      NaN/±Infinity dropped (non-finite doubles aren't representable)
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
  const customProperties: Record<string, PropertyValue> = {}
  if (props) {
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

  return event
}
