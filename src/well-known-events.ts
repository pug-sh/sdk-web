import type { JsonValue, MessageInitShape } from '@bufbuild/protobuf'
import type { WellKnownSchemaMap } from './well-known-events.generated.js'

/** Options passed to `track()`. `immediate` bypasses batching for priority events; `timestamp` overrides the default current-time (epoch milliseconds, e.g. `Date.now()`). */
export interface TrackOptions {
  readonly immediate?: boolean
  readonly timestamp?: number
}

export type { JsonValue }

export type WellKnownEventName = keyof WellKnownSchemaMap
export type WellKnownEventPropsMap = { [K in WellKnownEventName]: MessageInitShape<WellKnownSchemaMap[K]> }

/**
 * Overloaded track function type. First overload narrows properties for well-known
 * events; second accepts any string with loose Record<string, JsonValue> props.
 *
 * This is purely a compile-time affordance (autocomplete + type-checking). At runtime
 * there is no well-known/custom distinction — both routes flow through the same heuristic
 * property mapping in track.ts, and the schema descriptors are never bundled. If the first
 * overload's type check fails (e.g. wrong type for a known field), TypeScript silently
 * falls through to the second overload and the value is sent as-is; the server validates.
 */
export type TrackFn = {
  <K extends WellKnownEventName>(
    event: K,
    props?: WellKnownEventPropsMap[K] & Record<string, JsonValue>,
    options?: TrackOptions,
  ): void
  (event: string, props?: Record<string, JsonValue>, options?: TrackOptions): void
}
