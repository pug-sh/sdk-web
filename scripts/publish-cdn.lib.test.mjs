import { describe, expect, it } from 'vitest'
import {
  CACHE_CONTROL,
  CDN_ARTIFACTS,
  getObjectArgs,
  isObjectMissing,
  isPublishableVersion,
  objectKey,
  planAll,
  planUpload,
  putObjectArgs,
  sriHash,
} from './publish-cdn.lib.mjs'

// The value after a flag in a flat argv, e.g. flagValue(['--file', 'x'], '--file') === 'x'.
const flagValue = (args, flag) => args[args.indexOf(flag) + 1]

describe('objectKey', () => {
  it('version-pins the path with a leading v', () => {
    expect(objectKey('0.0.3', 'pug.min.js')).toBe('v0.0.3/pug.min.js')
    expect(objectKey('1.2.0', 'pug.min.js.map')).toBe('v1.2.0/pug.min.js.map')
  })
})

describe('sriHash', () => {
  it('matches the sha384 SRI format build-cdn.mjs prints (known vectors)', () => {
    // Independently computed: `printf '' | openssl dgst -sha384 -binary | base64`, likewise 'abc'.
    expect(sriHash(Buffer.from(''))).toBe('sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb')
    expect(sriHash(Buffer.from('abc'))).toBe('sha384-ywB1P0WjXou1oD1pmsZQBycsMqsO3tFjGotgWkP/W+2AhgcroefMI1i67KE0yCWn')
  })

  it('is sensitive to a single-byte change', () => {
    expect(sriHash(Buffer.from('abc'))).not.toBe(sriHash(Buffer.from('abd')))
  })
})

describe('planUpload', () => {
  it('uploads when the object is absent', () => {
    expect(planUpload('v0.0.3/pug.min.js', 'sha384-abc', null)).toBe('upload')
  })

  it('skips when the published bytes are identical (idempotent re-run / interrupted publish)', () => {
    expect(planUpload('v0.0.3/pug.min.js', 'sha384-abc', 'sha384-abc')).toBe('skip')
  })

  it('refuses to overwrite an immutable path whose bytes differ', () => {
    expect(() => planUpload('v0.0.3/pug.min.js', 'sha384-abc', 'sha384-xyz')).toThrow(/immutable/i)
    expect(() => planUpload('v0.0.3/pug.min.js', 'sha384-abc', 'sha384-xyz')).toThrow(/v0\.0\.3\/pug\.min\.js/)
  })
})

describe('planAll', () => {
  // A local fixture that mirrors CDN_ARTIFACTS, kept independent on purpose: planAll takes `artifacts`
  // as a parameter, so these logic tests stay pinned to a fixed set even if the real manifest grows.
  // (CDN_ARTIFACTS's own contents are asserted separately in the "artifact manifest" block below.)
  const artifacts = [
    { name: 'pug.min.js', contentType: 'text/javascript' },
    { name: 'pug.min.js.map', contentType: 'application/json' },
    { name: 'pug.min.js.LEGAL.txt', contentType: 'text/plain; charset=utf-8' },
  ]
  // Inject the two I/O seams as plain maps: local bytes keyed by artifact name, remote bytes keyed by
  // object key. Absent from the map → null, matching the real readLocal/fetchRemote contract.
  const deps = (local, remote) => ({
    readLocal: name => (name in local ? Buffer.from(local[name]) : null),
    fetchRemote: key => (key in remote ? Buffer.from(remote[key]) : null),
  })

  it('plans an upload for every artifact when nothing is published yet (fresh release)', () => {
    const plans = planAll(
      artifacts,
      '0.0.3',
      deps({ 'pug.min.js': 'js', 'pug.min.js.map': 'map', 'pug.min.js.LEGAL.txt': 'legal' }, {}),
    )
    expect(plans.map(p => p.action)).toEqual(['upload', 'upload', 'upload'])
    expect(plans.map(p => p.key)).toEqual(['v0.0.3/pug.min.js', 'v0.0.3/pug.min.js.map', 'v0.0.3/pug.min.js.LEGAL.txt'])
    // The plan carries exactly what Phase 2 needs to upload: artifact name, content type, and size.
    expect(plans[0]).toMatchObject({ name: 'pug.min.js', contentType: 'text/javascript', size: 2 })
  })

  it('skips already-published identical bytes and uploads the rest (interrupted publish resumes)', () => {
    const plans = planAll(
      artifacts,
      '0.0.3',
      deps(
        { 'pug.min.js': 'js', 'pug.min.js.map': 'map', 'pug.min.js.LEGAL.txt': 'legal' },
        { 'v0.0.3/pug.min.js': 'js' }, // only pug.min.js landed before the prior run was interrupted
      ),
    )
    expect(plans.map(p => p.action)).toEqual(['skip', 'upload', 'upload'])
  })

  it('aborts the WHOLE release — throwing before any plan is returned — when an immutable path differs', () => {
    // The load-bearing ordering guarantee behind Phase 1 / Phase 2 in publish-cdn.mjs: planAll plans
    // every artifact and throws on a mismatch, so it never hands Phase 2 a partial plans array to act
    // on. A mismatch on the SECOND artifact must still abort the whole run — no upload can precede it.
    let plans
    expect(() => {
      plans = planAll(
        artifacts,
        '0.0.3',
        deps(
          { 'pug.min.js': 'js', 'pug.min.js.map': 'map-NEW', 'pug.min.js.LEGAL.txt': 'legal' },
          { 'v0.0.3/pug.min.js.map': 'map-OLD' }, // 2nd artifact already published with different bytes
        ),
      )
    }).toThrow(/immutable/i)
    expect(plans).toBeUndefined() // nothing handed to Phase 2 → no artifact can have been uploaded
  })

  it('throws when a build artifact is missing locally (so a half-built dist never half-publishes)', () => {
    expect(() =>
      planAll(
        artifacts,
        '0.0.3',
        deps({ 'pug.min.js': 'js' }, {}), // .map and .LEGAL.txt were not built
      ),
    ).toThrow(/missing build artifact/i)
  })
})

describe('isObjectMissing', () => {
  // These strings mirror wrangler's real `r2 object get` failure output — they are the contract with an
  // external tool. If a wrangler upgrade changes the absent-object wording, re-capture the vector here,
  // or every fresh publish (all objects absent) would wrongly abort in Phase 1. The bare "404: Not
  // Found" is load-bearing, not a loose catch-all: it is what wrangler prints for a genuinely-missing
  // object, so isObjectMissing must match it (see the rationale on the function).
  it('treats R2 "key does not exist" / 404 as an absent object', () => {
    expect(isObjectMissing('The specified key does not exist. [code: 10007]')).toBe(true)
    expect(isObjectMissing('✘ [ERROR] ... - 404: Not Found')).toBe(true)
    expect(isObjectMissing('NoSuchKey')).toBe(true)
  })

  it('fails closed: auth/other errors and empty output are NOT treated as absent', () => {
    expect(isObjectMissing('Authentication error [code: 10000]')).toBe(false)
    expect(isObjectMissing('You must be logged in to use wrangler')).toBe(false)
    expect(isObjectMissing('')).toBe(false)
    // A wrong/absent BUCKET is a config error, not an absent key — it must stay fatal, so a
    // misconfigured publish never looks like "nothing published yet → safe to upload".
    expect(isObjectMissing('The specified bucket does not exist. [code: 10006]')).toBe(false)
  })
})

describe('isPublishableVersion', () => {
  it('accepts the semver shapes we mint into a CDN path', () => {
    expect(isPublishableVersion('0.0.3')).toBe(true)
    expect(isPublishableVersion('1.2.0')).toBe(true)
    expect(isPublishableVersion('1.0.0-rc.1')).toBe(true) // prerelease
    expect(isPublishableVersion('1.0.0+build.5')).toBe(true) // build metadata
  })

  it('rejects missing/garbage versions so a publish never mints "vundefined/…"', () => {
    expect(isPublishableVersion(undefined)).toBe(false)
    expect(isPublishableVersion('')).toBe(false)
    expect(isPublishableVersion('latest')).toBe(false)
    expect(isPublishableVersion('1.2')).toBe(false)
  })
})

describe('wrangler argv', () => {
  // The load-bearing regression: without --remote, wrangler's r2 commands hit local miniflare storage
  // and the publish is a silent no-op. Both get and put MUST target the real bucket.
  it('always passes --remote', () => {
    expect(getObjectArgs('pugs-dev-cdn', 'v0.0.3/pug.min.js')).toContain('--remote')
    expect(putObjectArgs('pugs-dev-cdn', 'v0.0.3/pug.min.js', 'dist/cdn/pug.min.js', 'text/javascript')).toContain(
      '--remote',
    )
  })

  it('getObjectArgs reads the object to stdout', () => {
    const args = getObjectArgs('pugs-dev-cdn', 'v0.0.3/pug.min.js')
    expect(args.slice(0, 4)).toEqual(['r2', 'object', 'get', 'pugs-dev-cdn/v0.0.3/pug.min.js'])
    expect(args).toContain('--pipe')
  })

  it('putObjectArgs sets the file, content type, and immutable cache header', () => {
    const args = putObjectArgs('pugs-dev-cdn', 'v0.0.3/pug.min.js', 'dist/cdn/pug.min.js', 'text/javascript')
    expect(args.slice(0, 4)).toEqual(['r2', 'object', 'put', 'pugs-dev-cdn/v0.0.3/pug.min.js'])
    expect(flagValue(args, '--file')).toBe('dist/cdn/pug.min.js')
    expect(flagValue(args, '--content-type')).toBe('text/javascript')
    expect(flagValue(args, '--cache-control')).toBe(CACHE_CONTROL)
  })
})

describe('artifact manifest', () => {
  it('lists exactly the three files build-cdn.mjs emits, pug.min.js first as JavaScript', () => {
    expect(CDN_ARTIFACTS.map(a => a.name)).toEqual(['pug.min.js', 'pug.min.js.map', 'pug.min.js.LEGAL.txt'])
    expect(CDN_ARTIFACTS[0].contentType).toBe('text/javascript')
  })

  it('caches immutably for a year', () => {
    expect(CACHE_CONTROL).toMatch(/\bimmutable\b/)
    expect(CACHE_CONTROL).toMatch(/max-age=31536000/)
  })
})
