import type { JSONValue } from './track.js'

export { type BatchConfig } from './batch.js'
export { destroy, identify, init, reset, track, type CottonConfig, type InitOptions } from './cotton.js'
export { rotate, type SessionConfig } from './session.js'
export { subscribePush, unsubscribePush, setupNotificationClickTracking, type PushOptions } from './push.js'
export {
  type JSONValue,
  type TrackFn,
  type TrackOptions,
  type WellKnownEventName,
  type WellKnownEventPropsMap,
} from './track.js'

// Deprecated aliases for backward compatibility — remove in next major version.
export type JsonValue = JSONValue
export type JsonObject = { [key: string]: JSONValue }
export { type WellKnownEventName as CottonEventName } from './track.js'
