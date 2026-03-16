import { EventSchema, type Event } from '@buf/fivebits_cotton.bufbuild_es/events/v1/events_pb.js'
import { create } from '@bufbuild/protobuf'
import { timestampFromMs, timestampNow } from '@bufbuild/protobuf/wkt'
import { parseBrowser, parseOs, parseUtmParams } from './parsers.js'

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
  const { browser, browserVersion } = parseBrowser(navigator.userAgent)
  const { os, osVersion, deviceType } = parseOs(navigator.userAgent)
  const utmProps = parseUtmParams(window.location.search)

  return create(EventSchema, {
    autoProperties: {
      $projectId: projectId,
      $url: window.location.href,
      $referrer: document.referrer,
      $userAgent: navigator.userAgent,
      $browser: browser,
      $browserVersion: browserVersion,
      $os: os,
      $osVersion: osVersion,
      $deviceType: deviceType,
      $locale: navigator.language,
      $screenWidth: String(window.screen.width),
      $screenHeight: String(window.screen.height),
      $pageTitle: document.title,
      ...utmProps,
    },
    customProperties: props ? flattenJSONValue(props) : {},
    kind,
    occurTime,
  })
}

export type TrackFn<T extends string> = (event: T, props?: Record<string, JSONValue>, options?: TrackOptions) => void
