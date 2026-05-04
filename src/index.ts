export { type BatchConfig } from './batch.js'
export { destroy, identify, init, reset, track, type PugConfig, type InitOptions } from './pug.js'
export { rotate, type SessionConfig } from './session.js'
export { subscribePush, unsubscribePush, setupNotificationClickTracking, type PushOptions } from './push.js'
export { type TrackFn, type TrackOptions, type WellKnownEventName, type WellKnownEventPropsMap } from './track.js'
export type { JsonObject, JsonValue } from '@bufbuild/protobuf'

// Deprecated aliases for backward compatibility — remove in next major version.
export { type WellKnownEventName as PugEventName } from './track.js'
