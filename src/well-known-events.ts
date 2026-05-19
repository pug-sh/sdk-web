import type { JsonValue, MessageInitShape } from '@bufbuild/protobuf'
import { wellKnownSchemas } from './well-known-events.generated.js'

/** Options passed to `track()`. `immediate` bypasses batching for priority events; `timestamp` overrides the default current-time (epoch milliseconds, e.g. `Date.now()`). */
export interface TrackOptions {
  readonly immediate?: boolean
  readonly timestamp?: number
}

export type { JsonValue }
export { wellKnownSchemas }

type WellKnownSchemas = typeof wellKnownSchemas
export type WellKnownEventName = keyof WellKnownSchemas
export type WellKnownEventPropsMap = { [K in WellKnownEventName]: MessageInitShape<WellKnownSchemas[K]> }

/**
 * Overloaded track function type. First overload narrows properties for well-known
 * events; second accepts any string with loose Record<string, JsonValue> props.
 *
 * Note: if the first overload's type check fails (e.g., wrong type for a known field),
 * TypeScript silently falls through to the second overload. Runtime validation in
 * validateWellKnownProps is the actual safety net.
 */
export type TrackFn = {
  <K extends WellKnownEventName>(
    event: K,
    props?: WellKnownEventPropsMap[K] & Record<string, JsonValue>,
    options?: TrackOptions,
  ): void
  (event: string, props?: Record<string, JsonValue>, options?: TrackOptions): void
}
