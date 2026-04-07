import { type Event, EventSchema } from '@buf/fivebits_cotton.bufbuild_es/sdk/events/v1/events_pb.js'
import { create, type JsonObject } from '@bufbuild/protobuf'
import { timestampFromMs, timestampNow } from '@bufbuild/protobuf/wkt'
import { createValidator } from '@bufbuild/protovalidate'
import { log } from './logger.js'
import { parseUserAgentData, parseUtmParams } from './parsers.js'
import { SDK_VERSION } from './version.js'

const validator = createValidator()

/** Options passed to `track()`. `immediate` bypasses batching for priority events; `timestamp` overrides the default current-time (epoch milliseconds, e.g. `Date.now()`). */
export interface TrackOptions {
  readonly immediate?: boolean
  readonly timestamp?: number
}

const flattenJsonObject = (props: JsonObject) => {
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
  props?: JsonObject,
  opts?: TrackOptions
): Event | null => {
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
    customProperties: props ? flattenJsonObject(props) : {},
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

export type TrackFn<T extends string> = (event: T, props?: JsonObject, options?: TrackOptions) => void
