/**
 * Type-level tests for `CrossSubdomainConfig`. Never executed and never emitted: `bun run typecheck`
 * checks this file with tsc, the build's tsconfig excludes `*.test-d.ts`, and vitest does not match
 * it.
 *
 * Making `domain` optional so `{ maxAgeDays }` alone keeps auto-discovery also made `{}` legal, and
 * `{}` reaches the same registrable-domain probe as `true` — inferring the cross-subdomain opt-in
 * that CLAUDE.md and the threat model say is never inferred. A config builder spreading unset
 * optionals produces exactly that object.
 *
 * Each `@ts-expect-error` is the guard and fails in the right direction: if the expected error stops
 * happening, tsc reports the unused directive itself (TS2578).
 */
import type { CrossSubdomainConfig } from './cookie.js'

// ── The legal shapes must compile ────────────────────────────────────────────────────────────────
const off: CrossSubdomainConfig = false
const on: CrossSubdomainConfig = true
const pinned: CrossSubdomainConfig = { domain: 'acme.com' }
const lifetimeOnly: CrossSubdomainConfig = { maxAgeDays: 180 }
const both: CrossSubdomainConfig = { domain: 'acme.com', maxAgeDays: 180 }

void off
void on
void pinned
void lifetimeOnly
void both

// ── Opting in must be stated ─────────────────────────────────────────────────────────────────────

// @ts-expect-error an empty object must not opt into cross-subdomain identity
const inferred: CrossSubdomainConfig = {}

void inferred
