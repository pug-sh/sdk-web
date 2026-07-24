export type { JsonObject, JsonValue } from '@bufbuild/protobuf'
export { type BatchConfig } from './batch.js'
export {
  type AutoCaptureConfig,
  type AutoCaptureSelection,
  type CrossSubdomainConfig,
  destroy,
  getTrackingConsent,
  type InitOptions,
  identify,
  init,
  isConsentPending,
  isTrackingEnabled,
  optInTracking,
  optOutTracking,
  type PugConfig,
  type RejectConsent,
  reset,
  setAutoCapture,
  setTrackingConsent,
  type TrackingConsent,
  type TrackingConsentConfig,
  track,
} from './pug.js'
export { rotate, type SessionConfig } from './session.js'
export {
  type BeforeSendEvent,
  type BeforeSendFn,
  type PropValue,
  type TrackEventProps,
  type TrackFn,
  type TrackOptions,
  type WellKnownEventName,
  // Deprecated alias for backward compatibility — remove in next major version.
  type WellKnownEventName as PugEventName,
  type WellKnownEventPropsMap,
} from './track.js'
