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
 * A property value the SDK can send. Mirrors what `jsValueToPropertyValue` accepts at runtime (see
 * track.ts): `JsonValue` plus `bigint` (-> `intValue`) and `Date` (-> `timestampValue`).
 *
 * The two extras are not optional garnish. protobuf-es maps proto `int64` to `bigint`, so a bare
 * `Record<string, JsonValue>` makes every int64 field on a well-known event **unwritable in any
 * spelling** — `number` fails the message shape, `bigint` fails the index signature. Widening here
 * is what lets the typed half and the extras half agree; `track-types.test-d.ts` pins it.
 */
export type PropValue = JsonValue | bigint | Date

/**
 * Properties accepted for an event: a well-known event's typed shape (plus arbitrary extras, which
 * are always allowed and sent as custom properties) when the name is a known one, and a loose bag
 * for any other string.
 *
 * The `[E] extends [WellKnownEventName]` tuple wrapper is load-bearing, not a stray: it makes the
 * conditional **non-distributive**. A bare `E extends WellKnownEventName` distributes over the
 * 119-member name union whenever `E` is still generic, which is exactly what happens inside a
 * wrapper that forwards its own type parameter:
 *
 * ```ts
 * const wrap: TrackFn = (event, props, options) => track(event, props, options)
 * // distributive: error TS2590: Expression produces a union type that is too complex to represent.
 * ```
 *
 * That is a compiler resource bailout, not a diagnosable error — it names no cause and suggests no
 * fix, and `TrackFn` is a public export, so typing a wrapper with it is the obvious thing to reach
 * for. Wrapping both sides in tuples evaluates the check once against the whole of `E` instead of
 * once per member. Call sites are unaffected (`E` is a single literal there, so distribution was a
 * no-op).
 *
 * `E & WellKnownEventName` in the true branch is load-bearing for the same reason, and reads even
 * more like a no-op — the tuple guard already constrains `E` enough that `WellKnownEventPropsMap[E]`
 * is legal. But the bare form expands the indexed access eagerly across all 119 members, so dropping
 * the intersection reintroduces TS2590 at the same `forward` call shape. Keep both.
 *
 * Note the two are not independently pinned: removing *only* the tuple still typechecks, because the
 * intersection alone defers the expansion. `track-types.test-d.ts` catches the fully-reverted form,
 * not either half on its own.
 */
export type TrackEventProps<E extends string> = [E] extends [WellKnownEventName]
  ? WellKnownEventPropsMap[E & WellKnownEventName] & Record<string, PropValue>
  : Record<string, PropValue>

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
