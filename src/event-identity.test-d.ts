/**
 * Type-level tests for `EventIdentity`. Never executed and never emitted: `bun run typecheck` checks
 * this file with tsc, the build's tsconfig excludes `*.test-d.ts`, and vitest's patterns do not
 * match it.
 *
 * `EventIdentity`'s JSDoc claims it makes "cookieless with ids" and "consented without ids"
 * unrepresentable at compile time. Only the second half held: with no property shared between the
 * two arms TypeScript had no discriminant, and excess-property checking against a union treats a
 * property as known if it exists in *any* constituent — so every spelling of a cookieless event
 * carrying identity compiled. Runtime was fail-safe (the cookieless arm drops the supplied ids), but
 * that is a runtime guard the comment credited to the type system, and no runtime test can observe a
 * *missing* compile error.
 *
 * Each `@ts-expect-error` is the guard and fails in the right direction: if the expected error stops
 * happening, tsc reports the unused directive as an error itself (TS2578).
 *
 * Keep each `@ts-expect-error` expression on a single line — the directive applies only to the line
 * that follows it, so a formatter-wrapped expression would silently stop being checked.
 */
import type { EventIdentity } from './track.js'

const sessionId = 's'
const distinctId = 'd'
const ids = { sessionId, distinctId }

// ── The two legal shapes must compile ────────────────────────────────────────────────────────────
const cookieless: EventIdentity = { cookieless: true }
const identified: EventIdentity = { sessionId: 'sess', distinctId: 'anon-1' }
const identifiedFromSpread: EventIdentity = { ...ids }
void cookieless
void identified
void identifiedFromSpread

// ── "cookieless with ids" must be unrepresentable, in every spelling ─────────────────────────────
// All four compiled before the `?: never` fences were added; the JSDoc claimed otherwise.

// @ts-expect-error cookieless events must not carry identity (object literal)
const withIdsLiteral: EventIdentity = { cookieless: true, sessionId: 's', distinctId: 'd' }

// @ts-expect-error cookieless events must not carry identity (spread)
const withIdsSpread: EventIdentity = { cookieless: true, ...ids }

// @ts-expect-error cookieless events must not carry identity (variable reference)
const withIdsVariable: EventIdentity = { cookieless: true as const, sessionId, distinctId }

// A tagged union (`{ kind: 'cookieless' } | { kind: 'identified', ... }`) rejects only the first of
// these — the spread and variable forms still compile — which is why it is not the fix here.
const built = { cookieless: true as const, ...ids }
// @ts-expect-error cookieless events must not carry identity (pre-built object)
const withIdsPrebuilt: EventIdentity = built

void withIdsLiteral
void withIdsSpread
void withIdsVariable
void withIdsPrebuilt

// ── "consented without ids" must stay unrepresentable (this half always held) ────────────────────

// @ts-expect-error a non-cookieless identity must supply both ids
const missingBoth: EventIdentity = {}

// @ts-expect-error a non-cookieless identity must supply distinctId too
const missingDistinct: EventIdentity = { sessionId: 'sess' }

// @ts-expect-error a non-cookieless identity must supply sessionId too
const missingSession: EventIdentity = { distinctId: 'anon-1' }

void missingBoth
void missingDistinct
void missingSession

// ── `cookieless: false` must not be a way in ─────────────────────────────────────────────────────
// toEvent branches on the *value* (`identity.cookieless === true`), but the type is what stops a
// `false` from reaching it and being read as a consented event with no ids.

// @ts-expect-error cookieless is `true` or absent — never false
const explicitlyFalse: EventIdentity = { cookieless: false, sessionId: 's', distinctId: 'd' }

void explicitlyFalse
