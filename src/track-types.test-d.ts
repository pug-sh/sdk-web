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
import { track } from './index.js'

// ── Well-known events: correct payloads must compile ─────────────────────────────────────────────
track('purchase', { productId: 'sku_123', amount: 49, currency: 'USD' })
track('purchase', {})

// Extra properties beyond the typed ones are always allowed, and sent as custom properties.
track('purchase', { amount: 49, currency: 'USD', ourOwnField: 'allowed' })

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
