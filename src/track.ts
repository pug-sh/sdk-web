import { EventSchema, type Event } from '@buf/fivebits_cotton.bufbuild_es/events/v1/events_pb.js'
import { create } from '@bufbuild/protobuf'
import { timestampFromMs, timestampNow } from '@bufbuild/protobuf/wkt'

/** Options passed to `track()`. `immediate` bypasses batching for priority events; `timestamp` overrides the default current-time. */
export interface TrackOptions {
  readonly immediate?: boolean
  readonly timestamp?: number
}

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }

const flattenJSONValue = (props: Record<string, JSONValue>) => {
  const m = {} as Event['customProperties']
  for (const k of Object.keys(props)) {
    m[k] = typeof props[k] === 'string' ? props[k] : JSON.stringify(props[k])
  }
  return m
}

export const toEvent = (projectId: string, kind: string, props?: Record<string, JSONValue>, opts?: TrackOptions) => {
  const occurTime = opts?.timestamp ? timestampFromMs(opts.timestamp) : timestampNow()

  return create(EventSchema, {
    autoProperties: {
      projectId,
      url: window.location.href,
      referrer: document.referrer,
      userAgent: navigator.userAgent,
    },
    customProperties: props ? flattenJSONValue(props) : {},
    kind,
    occurTime,
  })
}

export type TrackFn<T extends string> = (event: T, props?: Record<string, JSONValue>, options?: TrackOptions) => void
