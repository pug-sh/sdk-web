export type { JsonObject, JsonValue } from '@bufbuild/protobuf'
export { type BatchConfig } from './batch.js'
export {
  type AutoCaptureConfig,
  type AutoCaptureSelection,
  destroy,
  getTrackingConsent,
  type InitOptions,
  identify,
  init,
  isTrackingEnabled,
  optInTracking,
  optOutTracking,
  type PugConfig,
  reset,
  setAutoCapture,
  type TrackingConsent,
  type TrackingConsentConfig,
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
