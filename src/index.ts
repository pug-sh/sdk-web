export type { JsonObject, JsonValue } from '@bufbuild/protobuf'
export { type BatchConfig } from './batch.js'
export {
  type AutoTrackOptions,
  type AutoTrackSelection,
  destroy,
  type InitOptions,
  identify,
  init,
  type PugConfig,
  reset,
  track,
} from './pug.js'
export { type PushOptions, setupNotificationClickTracking, subscribePush, unsubscribePush } from './push.js'
export { rotate, type SessionConfig } from './session.js'
// Deprecated aliases for backward compatibility — remove in next major version.
export {
  type TrackFn,
  type TrackOptions,
  type WellKnownEventName,
  type WellKnownEventName as PugEventName,
  type WellKnownEventPropsMap,
} from './track.js'
