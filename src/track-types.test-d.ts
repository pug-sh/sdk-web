/**
 * Type-level tests for `TrackFn`. Never executed and never emitted: `bun run typecheck` checks this
 * file with tsc, the build's tsconfig excludes `*.test-d.ts`, and vitest's patterns do not match it.
 *
 * Every `@ts-expect-error` below is a regression guard, and it fails loudly in the direction that
 * matters: if the expected error stops happening, TypeScript reports the now-unused directive as an
 * error itself. The failure being guarded against is a *missing* type error, which no runtime test
 * can observe.
 *
 * Keep each `@ts-expect-error` call on a single line — the directive only applies to the line that
 * follows it, so a formatter-wrapped call would silently stop being checked.
 */
import {
  type AutoCaptureSelection,
  type TrackEventProps,
  type TrackFn,
  type TrackOptions,
  track,
  type WellKnownEventName,
} from './index.js'

// ── Well-known events: correct payloads must compile ─────────────────────────────────────────────
track('purchase', { productId: 'sku_123', amount: 49, currency: 'USD' })
track('purchase', {})

// Extra properties beyond the typed ones are always allowed, and sent as custom properties.
track('purchase', { amount: 49, currency: 'USD', ourOwnField: 'allowed' })

// ── int64 and Date properties must be writable ───────────────────────────────────────────────────
// protobuf-es maps proto `int64` to `bigint`, so five well-known events (file_uploaded,
// file_downloaded, export_completed, chat_attachment_uploaded, chat_attachment_downloaded) carry
// `bigint` fields. The old permissive overload absorbed these silently; when it was removed they
// became unwritable in *every* spelling — `number` fails the message shape, and `bigint` failed the
// `Record<string, JsonValue>` half. `PropValue` is what makes both halves agree, and it matches what
// `jsValueToPropertyValue` accepts at runtime (bigint -> intValue, Date -> timestampValue).
track('file_uploaded', { fileId: 'f1', sizeBytes: 1024n })
track('my_custom_event', { when: new Date(), big: 7n })

// ── Custom events: any other string, with loose props ────────────────────────────────────────────
track('upgrade_clicked', { source: 'settings' })
track('an_event_we_just_invented', { a: 1, b: true, c: 'three' })

// ── Options ──────────────────────────────────────────────────────────────────────────────────────
track('error_occurred', { errorCode: 'PAYMENT_FAILED' }, { immediate: true })
track('purchase', { amount: 49 }, { timestamp: 1_700_000_000_000 })

// ── Wrong types on a well-known field must NOT compile ───────────────────────────────────────────
// These are the whole reason TrackFn is one conditional signature rather than two overloads. With a
// permissive `(event: string, props?: Record<string, JsonValue>)` fallback, TypeScript abandons the
// failed well-known signature, matches the fallback (a string is a perfectly good JsonValue), and
// the bad payload compiles and ships to be rejected server-side.

// @ts-expect-error — amount is typed number
track('purchase', { productId: 'sku_1', amount: '49', currency: 'USD' })

// @ts-expect-error — currency is typed string
track('purchase', { amount: 49, currency: 999 })

// @ts-expect-error — immediate is typed boolean
track('purchase', { amount: 49 }, { immediate: 'yes' })

// ── Wrappers must compile ────────────────────────────────────────────────────────────────────────
// `TrackFn` is a public export, so typing an analytics facade with it is the obvious move. These
// guard the tuple wrapper in `TrackEventProps`: with a distributive conditional both forms fail with
// `TS2590: Expression produces a union type that is too complex to represent` — a compiler resource
// bailout that names no cause and suggests no fix. Exported because `noUnusedLocals` is on.

export const forward: TrackFn = (event, props, options) => {
  track(event, props, options)
}

export const wrap = <E extends WellKnownEventName | (string & {})>(
  event: E,
  props?: TrackEventProps<E>,
  options?: TrackOptions,
): void => track(event, props, options)

// Forwarding must not cost the caller their type-checking.
wrap('purchase', { productId: 'sku_123', amount: 49, currency: 'USD' })

// @ts-expect-error — amount is typed number, through the wrapper too
wrap('purchase', { amount: '49' })

// ── autoCapture is an allowlist, and `false` must stay unwritable ────────────────────────────────
// `{ scroll: false }` reads as "everything except scroll" but enables nothing at all. The runtime
// warning covers JS and CDN callers; these pin the compile-time half, which nothing else does —
// pug.test.ts reaches those shapes through `as never` casts, so reverting the values to `boolean`
// would leave the whole suite green.

declare const runtimeFlag: boolean

// A selection may enable trackers, and may omit any it does not want.
export const selection: AutoCaptureSelection = { pageView: true, click: true }

// The documented idiom for a value known only at runtime. Must keep compiling — including under
// `exactOptionalPropertyTypes`, which is why the values are `true | undefined` rather than `true`.
export const dynamic: AutoCaptureSelection = { scroll: runtimeFlag || undefined }

// @ts-expect-error — `false` is the allowlist misread as a denylist
export const denylist: AutoCaptureSelection = { scroll: false }

// @ts-expect-error — a boolean-typed value would admit `false` at runtime
export const widened: AutoCaptureSelection = { scroll: runtimeFlag }
