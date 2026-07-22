/**
 * Type-level tests for `BeforeSendFn` / `BeforeSendEvent`. Never executed and never emitted, like
 * the other `*.test-d.ts` files — `bun run typecheck` is what runs them.
 *
 * These exist because the README's own `beforeSend` examples did not compile: the bags were typed
 * `Record<string, PropValue>`, so `maskUrl(event.autoProperties.$url)` was a TS2345 and
 * `= undefined` a TS2322. No runtime test could see it — `src/*.test.ts` is excluded from
 * `tsconfig.typecheck` and `track.test.ts` reached the same shapes through an `as string` cast.
 *
 * Keep each `@ts-expect-error` expression on a single line — the directive applies only to the line
 * that follows it. For a block-bodied arrow the error lands *inside* the body, so annotate the
 * offending line, not the `const`.
 */
import type { BeforeSendFn } from './track.js'

// ── The documented idioms must compile ───────────────────────────────────────────────────────────

// Auto-property values are strings, so a `(url: string) => string` masker takes them directly.
const maskUrl = (url: string): string => (url ? url.replace(/\/orders\/\d+/, '/orders/:id') : url)

const masking: BeforeSendFn = event => {
  event.autoProperties.$url = maskUrl(event.autoProperties.$url)
  event.autoProperties.$referrer = maskUrl(event.autoProperties.$referrer)
  return event
}

// `delete` is the documented removal spelling; `= undefined` is not (see below).
const removing: BeforeSendFn = event => {
  delete event.autoProperties.$utmContent
  delete event.customProperties.ssn
  return event
}

// Block-bodied with no return: this is why the return type is `| void` and not `| undefined`.
// Such an arrow infers `void`, which is not assignable to `undefined` — nothing at runtime can
// tell the two apart, so only this file can pin it.
const inPlace: BeforeSendFn = event => {
  delete event.customProperties.ssn
}

const dropping: BeforeSendFn = event => (event.kind === 'internal_ping' ? null : event)

// A custom property is the caller's own type, so it needs narrowing before string use.
const narrowing: BeforeSendFn = event => {
  const action = event.customProperties.action
  if (typeof action === 'string') {
    event.customProperties.action = maskUrl(action)
  }
  return event
}

void masking
void removing
void inPlace
void dropping
void narrowing

// ── Replacing a bag must not compile ─────────────────────────────────────────────────────────────
// A hook that swapped a bag and returned nothing had its redaction silently discarded and the raw
// original sent. The runtime now honors the swap, but the bags are readonly so the mistake is a
// compile error first.

const swapAuto: BeforeSendFn = event => {
  // @ts-expect-error the bags are readonly — mutate in place instead of replacing
  event.autoProperties = { $url: 'REDACTED' }
  return event
}

const swapCustom: BeforeSendFn = event => {
  // @ts-expect-error the bags are readonly — mutate in place instead of replacing
  event.customProperties = {}
  return event
}

void swapAuto
void swapCustom

// ── `kind` must not be rewritable ────────────────────────────────────────────────────────────────
// The runtime ignores a rewritten kind entirely, so dropping `readonly` leaves every test green.

const reroute: BeforeSendFn = event => {
  // @ts-expect-error kind is readonly — rewriting it would reroute the event
  event.kind = 'spoofed'
  return event
}

void reroute

// ── `= undefined` must stay rejected ─────────────────────────────────────────────────────────────
// Removal is `delete`. Widening the bags to admit `undefined` would make every read optional and
// break the masking case above.

const assignUndefined: BeforeSendFn = event => {
  // @ts-expect-error use `delete` to remove a property, not `= undefined`
  event.autoProperties.$utmContent = undefined
  return event
}

void assignUndefined

// ── The return protocol must not admit stray values ──────────────────────────────────────────────
// `| void` must not degrade into "anything goes": a concise arrow whose body is an assignment or a
// `delete` returns a value, and silently accepting it would hide a hook that never returns an event.

// @ts-expect-error a number is not an event, null, or nothing
const returnsNumber: BeforeSendFn = () => 42

// @ts-expect-error `delete` evaluates to a boolean — use a block body for the in-place form
const returnsDelete: BeforeSendFn = event => delete event.customProperties.ssn

void returnsNumber
void returnsDelete
