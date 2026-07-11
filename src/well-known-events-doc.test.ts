import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Guards the two hand/generated boundaries that `make check-codegen`'s git-diff can't:
//   1. WELL_KNOWN_EVENTS.md and the generated type registry must list the same events
//      (they share one generator pass, so this catches hand-edits to either file).
//   2. The domain links in README.md are hand-written prose — they must stay in sync with
//      the reference doc's section headings, or the README silently drifts as new event
//      domains are vendored in.
// Runs in `bun run test` with no build step (reads committed files only).

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort()

const doc = read('../WELL_KNOWN_EVENTS.md')
const readme = read('../README.md')
const typeRegistry = read('./well-known-events.generated.ts')

describe('WELL_KNOWN_EVENTS.md reference doc', () => {
  it('lists exactly the events in the generated type registry', () => {
    const docEvents = sorted([...doc.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map(m => m[1]))
    const typeEvents = sorted([...typeRegistry.matchAll(/^ {2}([a-z0-9_]+): typeof /gm)].map(m => m[1]))
    expect(docEvents.length).toBeGreaterThan(0)
    expect(docEvents).toEqual(typeEvents)
  })

  it("README's domain links match the reference doc's section headings", () => {
    const docDomains = sorted([...doc.matchAll(/^## (.+)$/gm)].map(m => m[1].toLowerCase()))
    const readmeDomains = sorted([...readme.matchAll(/WELL_KNOWN_EVENTS\.md#([a-z0-9-]+)/g)].map(m => m[1]))
    expect(readmeDomains.length).toBeGreaterThan(0)
    expect(readmeDomains).toEqual(docDomains)
  })
})
