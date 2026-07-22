import { create } from '@bufbuild/protobuf'
import { timestampFromMs, timestampNow } from '@bufbuild/protobuf/wkt'
import { uuidv7 } from 'uuidv7'
import { type PropertyValue, PropertyValueSchema } from './gen/common/v1/property_value_pb.js'
import { type Event, EventSchema } from './gen/sdk/events/v1/events_pb.js'
import { log } from './logger.js'
import { parseUserAgentData, parseUtmParams } from './parsers.js'
import { SDK_VERSION } from './version.js'
import type { PropValue, TrackOptions, WellKnownEventName } from './well-known-events.js'

export type {
  JsonValue,
  PropValue,
  TrackEventProps,
  TrackFn,
  TrackOptions,
  WellKnownEventName,
  WellKnownEventPropsMap,
} from './well-known-events.js'

/** Plain-JS view of an event, before protobuf conversion. Mutate the bags in place — they are
 * readonly because replacing one and returning nothing would send the un-redacted original. */
export type BeforeSendEvent = {
  readonly kind: WellKnownEventName | (string & {})
  readonly autoProperties: Record<string, string>
  readonly customProperties: Record<string, PropValue>
}

/** Return the event to send it, `null` to drop it, or nothing to keep in-place mutations. */
export type BeforeSendFn = (event: BeforeSendEvent) => BeforeSendEvent | null | void

let beforeSend: BeforeSendFn | null = null
// One flag per failure class — a throw must not silence a later malformed return.
let beforeSendThrewWarned = false
let beforeSendMalformedWarned = false

// Re-asserted after the hook: the backend keys on $projectId and cannot re-derive the other two.
const PROTECTED_AUTO_PROPERTIES = ['$projectId', '$platform', '$sdkVersion'] as const

/** Wired from `init({ beforeSend })`; `undefined` clears it. Fails closed like the URL sanitizer:
 * a non-function drops every event rather than sending data the caller thought was scrubbed. */
export const configureBeforeSend = (fn?: BeforeSendFn): void => {
  if (fn !== undefined && typeof fn !== 'function') {
    log.warn('beforeSend must be a function; dropping all events to avoid sending unredacted data.')
    beforeSend = () => null
  } else {
    beforeSend = fn ?? null
  }
  beforeSendThrewWarned = false
  beforeSendMalformedWarned = false
}

// A Map/Set/array/class instance yields nothing from Object.entries, so accepting one would ship
// an event stripped to its re-asserted properties, silently.
const isPlainBag = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null) {
    return false
  }
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// Never throws. A hook that throws or returns garbage drops the event — there is no narrower thing
// to fail closed on, and the hook exists to keep something out of the payload.
const applyBeforeSend = (
  kind: string,
  autoProperties: Record<string, string>,
  customProperties: Record<string, PropValue>,
): { autoProperties: Record<string, unknown>; customProperties: Record<string, unknown> } | null => {
  if (!beforeSend) {
    return { autoProperties, customProperties }
  }

  // Snapshot first: the hook gets the live bag, so a `delete e.autoProperties.$projectId` would
  // otherwise empty the very thing we re-assert from.
  const protectedValues = PROTECTED_AUTO_PROPERTIES.map(k => autoProperties[k])

  // Held, not rebuilt: a hook that replaces a bag and returns nothing must not send the originals.
  const draft: BeforeSendEvent = { kind, autoProperties, customProperties }

  let returned: BeforeSendEvent | null | void
  try {
    returned = beforeSend(draft)
  } catch (err) {
    // Error type only — a hook that interpolates the value it was redacting would re-surface it.
    if (!beforeSendThrewWarned) {
      beforeSendThrewWarned = true
      log.warn(
        'beforeSend threw; dropping event to avoid sending unredacted data. Error type:',
        err instanceof Error ? err.name : typeof err,
      )
    }
    return null
  }

  if (returned === null) {
    log.debug(`Event "${kind}" dropped by beforeSend`)
    return null
  }
  // Undefined = mutated in place and fell off the end, which in-place editing invites.
  const shaped: BeforeSendEvent = returned === undefined ? draft : returned
  if (!isPlainBag(shaped) || !isPlainBag(shaped.autoProperties) || !isPlainBag(shaped.customProperties)) {
    if (!beforeSendMalformedWarned) {
      beforeSendMalformedWarned = true
      log.warn(
        'beforeSend returned a malformed event (expected the event, null, or nothing); dropping event to avoid sending unredacted data.',
      )
    }
    return null
  }

  const finalAuto: Record<string, unknown> = { ...shaped.autoProperties }
  PROTECTED_AUTO_PROPERTIES.forEach((key, i) => {
    finalAuto[key] = protectedValues[i]
  })
  return { autoProperties: finalAuto, customProperties: shaped.customProperties }
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

// Lives here, not in events/page_view.ts: `toEvent` gates $pageTitle on it, and core importing a
// tracker module breaks every test that vi.mocks it.
export const eventPageView = 'page_view' satisfies WellKnownEventName

/**
 * Event identity is a closed choice: either the server derives it (cookieless
 * mode — the event carries the flag and NO ids, which the backend requires:
 * a cookieless event that sends identity is rejected at validation), or the
 * caller supplies both ids. The union makes "cookieless with ids" and
 * "consented without ids" unrepresentable at compile time.
 *
 * The `?: never` members are what actually close it. Without them the two arms share no property,
 * so TypeScript has no discriminant to narrow on, and excess-property checking against a union
 * treats a property as known if it exists in *any* constituent — every spelling of a cookieless
 * event carrying identity compiled, including the spread and variable forms that an explicit
 * literal tag (`{ kind: 'cookieless' } | …`) would still admit. Pinned by event-identity.test-d.ts.
 */
export type EventIdentity =
  | { readonly cookieless: true; readonly sessionId?: never; readonly distinctId?: never }
  | { readonly cookieless?: never; readonly sessionId: string; readonly distinctId: string }

export const toEvent = (
  projectId: string,
  kind: string,
  identity: EventIdentity,
  props?: Record<string, unknown>,
  opts?: TrackOptions,
): Event | null => {
  // Built plain, hooked, then converted — so beforeSend sees values, not PropertyValue oneofs.
  const rawAutoProperties: Record<string, string> = {
    $projectId: projectId,
    // Not derivable server-side from the UA header (unlike $browser/$os/$device), so every SDK
    // sends it. Value set is web | ios | android, matching devices.proto's `platform` constraint.
    $platform: 'web',
    $url: window.location.href,
    $referrer: document.referrer,
    $locale: navigator.language,
    $screenWidth: String(window.screen.width),
    $screenHeight: String(window.screen.height),
    // Page-view only: titles carry names and order numbers, and every later event on the page
    // shares its sessionId anyway.
    ...(kind === eventPageView ? { $pageTitle: document.title } : {}),
    $sdkVersion: SDK_VERSION,
    ...parseUserAgentData(),
    ...parseUtmParams(window.location.search),
  }

  const shaped = applyBeforeSend(kind, rawAutoProperties, { ...props } as Record<string, PropValue>)

  if (!shaped) {
    return null
  }

  const autoProperties: Record<string, PropertyValue> = {}
  mapPropsViaHeuristic(shaped.autoProperties, autoProperties, kind)
  const customProperties: Record<string, PropertyValue> = {}
  mapPropsViaHeuristic(shaped.customProperties, customProperties, kind)

  let event: Event
  try {
    event = create(EventSchema, {
      eventId: uuidv7(),
      autoProperties,
      customProperties,
      kind,
      // Value, not key presence: `'cookieless' in identity` was true for `{ cookieless: false }` and
      // would have emitted `cookieless: true` for it. The type now forbids that shape, so this only
      // keeps the runtime branch agreeing with the type rather than contradicting it silently.
      ...(identity.cookieless === true
        ? { cookieless: true }
        : { sessionId: identity.sessionId, distinctId: identity.distinctId }),
      occurTime: opts?.timestamp && Number.isFinite(opts.timestamp) ? timestampFromMs(opts.timestamp) : timestampNow(),
    })
  } catch (err) {
    log.error(`Event "${kind}" dropped: failed to create Event proto:`, err)
    return null
  }

  return event
}
