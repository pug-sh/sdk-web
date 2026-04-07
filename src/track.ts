import { type Event, EventSchema } from '@buf/fivebits_cotton.bufbuild_es/sdk/events/v1/events_pb.js'
import { create, toJson, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf'
import { timestampFromMs, timestampNow } from '@bufbuild/protobuf/wkt'
import { createValidator } from '@bufbuild/protovalidate'
import { log } from './logger.js'
import { parseUserAgentData, parseUtmParams } from './parsers.js'
import { SDK_VERSION } from './version.js'
import { type JSONValue, type TrackOptions, type WellKnownEventName, wellKnownSchemas } from './well-known-events.js'

export type { JSONValue, TrackOptions } from './well-known-events.js'
export type { TrackFn, TrackProps, WellKnownEventName, WellKnownEventPropsMap } from './well-known-events.js'

const validator = createValidator()

const validateWellKnownProps = <Desc extends DescMessage>(
  schema: Desc,
  data: Record<string, unknown>
): Record<string, JSONValue> | null => {
  const knownNames = new Set(schema.fields.map(f => f.localName))
  const knownData: Record<string, unknown> = {}
  const extraData: Record<string, JSONValue> = {}
  for (const [k, v] of Object.entries(data)) {
    if (knownNames.has(k)) {
      knownData[k] = v
    } else {
      extraData[k] = v as JSONValue
    }
  }
  const msg = create(schema, knownData as MessageInitShape<Desc>)
  const result = validator.validate(schema, msg)
  if (result.kind === 'invalid') {
    log.error(
      `Properties validation failed for "${schema.typeName}":`,
      result.violations.map(v => `${v.field}: ${v.message}`).join(', ')
    )
    return null
  }
  return { ...(toJson(schema, msg) as Record<string, JSONValue>), ...extraData }
}

const flattenJSONValue = (props: Record<string, JSONValue>) => {
  const m: Record<string, string> = {}
  for (const k of Object.keys(props)) {
    m[k] = typeof props[k] === 'string' ? props[k] : JSON.stringify(props[k])
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
    resolvedProps = validateWellKnownProps(schema, props as MessageInitShape<typeof schema>) ?? undefined
    if (resolvedProps === undefined && props !== undefined) return null
  } else {
    resolvedProps = props as Record<string, JSONValue>
  }

  const event = create(EventSchema, {
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
    occurTime: opts?.timestamp ? timestampFromMs(opts.timestamp) : timestampNow(),
  })

  const result = validator.validate(EventSchema, event)
  if (result.kind === 'invalid') {
    log.error(`Event "${kind}" failed validation:`, result.violations.map(v => `${v.field}: ${v.message}`).join(', '))
    return null
  }

  return event
}
