import { EventSchema } from '@buf/fivebits_cotton.bufbuild_es/events/v1/events_pb.js'
import { create } from '@bufbuild/protobuf'
import { timestampFromMs, timestampNow } from '@bufbuild/protobuf/wkt'
import { parseUserAgentData, parseUtmParams } from './parsers.js'
import { SDK_VERSION } from './version.js'

/** Options passed to `track()`. `immediate` bypasses batching for priority events; `timestamp` overrides the default current-time (epoch milliseconds, e.g. `Date.now()`). */
export interface TrackOptions {
  readonly immediate?: boolean
  readonly timestamp?: number
}

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }

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
  props?: Record<string, JSONValue>,
  opts?: TrackOptions
) => {
  return create(EventSchema, {
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
    customProperties: props ? flattenJSONValue(props) : {},
    kind,
    sessionId,
    occurTime: opts?.timestamp ? timestampFromMs(opts.timestamp) : timestampNow(),
  })
}

export type TrackFn<T extends string> = (event: T, props?: Record<string, JSONValue>, options?: TrackOptions) => void
