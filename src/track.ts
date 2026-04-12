import { type Event, EventSchema } from '@buf/fivebits_cotton.bufbuild_es/sdk/events/v1/events_pb.js'
import { create, toJson, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf'
import { timestampFromMs, timestampNow } from '@bufbuild/protobuf/wkt'
import { createValidator } from '@bufbuild/protovalidate'
import { log } from './logger.js'
import { parseUserAgentData, parseUtmParams } from './parsers.js'
import { SDK_VERSION } from './version.js'
import { type JSONValue, type TrackOptions, type WellKnownEventName, wellKnownSchemas } from './well-known-events.js'

export type {
  JSONValue,
  TrackFn,
  TrackOptions,
  WellKnownEventName,
  WellKnownEventPropsMap,
} from './well-known-events.js'

const validator = createValidator()

/**
 * Validates properties for a well-known event against its protobuf schema.
 * Schema-known fields are validated via create() + protovalidate + toJson(alwaysEmitImplicit);
 * extra fields (not in the schema) pass through unvalidated.
 * Returns null if validation fails (event should be dropped).
 */
const validateWellKnownProps = <Desc extends DescMessage>(
  schema: Desc,
  kind: string,
  data: Record<string, unknown>
): Record<string, JSONValue> | null => {
  const knownNames = new Set(schema.fields.map(f => f.localName))
  const knownData: Record<string, unknown> = {}
  const extraData: Record<string, JSONValue> = {}
  for (const [k, v] of Object.entries(data)) {
    if (knownNames.has(k)) {
      knownData[k] = v
    } else if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') {
      log.warn(`Extra property "${k}" on event "${kind}" has non-serializable type ${typeof v}, skipping`)
    } else {
      extraData[k] = v as JSONValue
    }
  }

  let msg
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

  let json: Record<string, JSONValue>
  try {
    json = toJson(schema, msg, { alwaysEmitImplicit: true }) as Record<string, JSONValue>
  } catch (err) {
    log.error(`Event "${kind}" dropped: failed to serialize properties for "${schema.typeName}":`, err)
    return null
  }

  return { ...json, ...extraData }
}

/** Converts all property values to strings for the proto customProperties map. */
const flattenJSONValue = (props: Record<string, JSONValue>) => {
  const m: Record<string, string> = {}
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) {
      continue
    }
    if (typeof v === 'string') {
      m[k] = v
      continue
    }
    try {
      m[k] = JSON.stringify(v)
    } catch {
      log.warn(`Property "${k}" is not JSON-serializable (${typeof v}), skipping`)
    }
  }
  return m
}

export const toEvent = (
  projectId: string,
  kind: string,
  sessionId: string,
  distinctId: string,
  props?: Record<string, unknown>,
  opts?: TrackOptions
): Event | null => {
  let resolvedProps: Record<string, JSONValue> | undefined

  if (kind in wellKnownSchemas) {
    const schema = wellKnownSchemas[kind as WellKnownEventName]
    const validated = validateWellKnownProps(schema, kind, props ?? {})
    if (validated === null) {
      return null
    }
    resolvedProps = validated
  } else {
    resolvedProps = props as Record<string, JSONValue>
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
      customProperties: resolvedProps ? flattenJSONValue(resolvedProps) : {},
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
