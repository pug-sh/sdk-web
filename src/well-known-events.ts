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
 * Properties accepted for an event: a well-known event's typed shape (plus arbitrary extras, which
 * are always allowed and sent as custom properties) when the name is a known one, and a loose bag
 * for any other string.
 */
export type TrackEventProps<E extends string> = E extends WellKnownEventName
  ? WellKnownEventPropsMap[E] & Record<string, JsonValue>
  : Record<string, JsonValue>

/**
 * The `track()` signature: well-known event names get typed, autocompleted properties; any other
 * string is a custom event with loose props.
 *
 * This is purely a compile-time affordance. At runtime there is no well-known/custom distinction —
 * both flow through the same heuristic property mapping in track.ts, the schema descriptors are
 * never bundled (every import in well-known-events.generated.ts is `import type`), and the server
 * remains the only validator. This type erases completely; it costs nothing in the bundle.
 *
 * Deliberately ONE conditional signature rather than two overloads. With overloads — a narrow
 * well-known one followed by an `(event: string, props?: Record<string, JsonValue>)` fallback — a
 * wrong type on a known field (`track('purchase', { amount: '49' })`) does not error: TypeScript
 * abandons the failed first overload, matches the permissive second (a string is a fine JsonValue),
 * and the bad payload compiles and ships to be rejected server-side. The fallback silently absorbs
 * exactly the mistakes the typing exists to catch. Resolving props through a conditional type on a
 * single signature leaves nothing to fall through to, so the error surfaces on the offending
 * property.
 *
 * `(string & {})` in the constraint is what keeps both halves: it preserves editor autocomplete for
 * the well-known names in the union while still admitting any custom string. Widening it to plain
 * `string` would absorb the literals and lose the completions.
 */
export type TrackFn = <E extends WellKnownEventName | (string & {})>(
  event: E,
  props?: TrackEventProps<E>,
  options?: TrackOptions,
) => void
