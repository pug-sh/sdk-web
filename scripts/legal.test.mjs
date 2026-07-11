import { describe, expect, it } from 'vitest'
import { backfillLegalNotices } from './legal.mjs'

// The CDN build attributes bundled deps two ways: esbuild extracts inline banners for packages that
// ship one (uuidv7), and backfillLegalNotices() appends the rest (@bufbuild/protobuf). These tests
// pin the deliberate substring dedup — a boundary-anchored `^<dep> v` match (CodeRabbit's PR #13
// suggestion) would duplicate uuidv7's attribution, so it is intentionally NOT used.
describe('backfillLegalNotices', () => {
  // Shape of esbuild's 'linked' extraction for uuidv7: keyed by source path, the package named only
  // inside the banner body — never as a `uuidv7 v<version>:` header.
  const esbuildExtracted = [
    'Bundled license information:',
    '',
    'uuidv7/dist/index.js:',
    '  /**',
    '   * uuidv7: A JavaScript implementation of UUID version 7',
    '   * @license Apache-2.0',
    '   */',
    '',
  ].join('\n')

  const deps = { '@bufbuild/protobuf': '^2.12.0', uuidv7: '^1.1.0' }
  const packages = {
    uuidv7: { version: '1.1.0', license: 'Apache-2.0', homepage: 'https://github.com/LiosK/uuidv7' },
    '@bufbuild/protobuf': {
      version: '2.12.0',
      license: '(Apache-2.0 AND BSD-3-Clause)',
      repository: { url: 'https://github.com/bufbuild/protobuf-es.git' },
    },
  }
  const readPkg = dep => packages[dep]

  it('backfills only deps esbuild did not already attribute — no duplicate uuidv7', () => {
    const out = backfillLegalNotices(esbuildExtracted, deps, readPkg)

    // @bufbuild/protobuf ships no inline banner → backfilled as a `<dep> v<version>:` header.
    expect(out).toContain('@bufbuild/protobuf v2.12.0:')
    expect(out).toContain('License: (Apache-2.0 AND BSD-3-Clause)')
    expect(out).toContain('https://github.com/bufbuild/protobuf-es.git')
    // uuidv7 already appears in esbuild's banner → skipped, so no `uuidv7 v...:` header is appended.
    expect(out).not.toContain('uuidv7 v1.1.0:')
  })

  it('would regress under a boundary-anchored `^<dep> v` match: esbuild never writes that header', () => {
    // The anchored pattern CodeRabbit proposed. It cannot see uuidv7's extracted banner...
    expect(esbuildExtracted).not.toMatch(/^uuidv7 v/m)
    // ...even though the banner clearly attributes uuidv7, which is exactly why the substring guard
    // (`legal.includes(dep)`) is the correct dedup and switching to the anchored match duplicates it.
    expect(esbuildExtracted.includes('uuidv7')).toBe(true)
  })

  it('falls back to an empty URL when a package omits homepage and repository', () => {
    const out = backfillLegalNotices('Bundled license information:\n', { solo: '^1.0.0' }, () => ({
      version: '1.0.0',
      license: 'MIT',
    }))

    expect(out).toContain('solo v1.0.0:')
    expect(out).toContain('License: MIT')
  })
})
