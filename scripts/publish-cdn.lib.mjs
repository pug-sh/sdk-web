// Pure, testable logic for publishing the CDN bundle to Cloudflare R2 (see scripts/publish-cdn.mjs
// for the side-effectful CLI). Kept in a separate module so scripts/publish-cdn.lib.test.mjs can pin
// the load-bearing invariants — most importantly that every wrangler invocation carries `--remote`
// (without it `wrangler r2 object get/put` hit LOCAL miniflare storage and the publish is a silent
// no-op) and that an already-published, immutable path is never overwritten with different bytes.
import { createHash } from 'node:crypto'

// One-year immutable cache: every path is version-pinned (v<x.y.z>/…), so the bytes at a given URL
// never change and browsers/edges may cache them forever.
export const CACHE_CONTROL = 'public, max-age=31536000, immutable'

// The artifacts scripts/build-cdn.mjs emits into dist/cdn/, in upload order. Content types are set
// explicitly because R2 does not infer them: pug.min.js must serve as JavaScript, the sourcemap as
// JSON, and the Apache-2.0 attribution sidecar as text.
export const CDN_ARTIFACTS = [
  { name: 'pug.min.js', contentType: 'text/javascript' },
  { name: 'pug.min.js.map', contentType: 'application/json' },
  { name: 'pug.min.js.LEGAL.txt', contentType: 'text/plain; charset=utf-8' },
]

// R2 object key for an artifact of a given release, e.g. objectKey('0.0.3', 'pug.min.js') →
// 'v0.0.3/pug.min.js'. The documented `<script>` URL is https://cdn.pugs.dev/<key>.
export const objectKey = (version, name) => `v${version}/${name}`

// Subresource Integrity hash of some bytes, matching the value scripts/build-cdn.mjs prints, so the
// publish step can reprint an SRI guaranteed to describe the uploaded pug.min.js.
export const sriHash = bytes => `sha384-${createHash('sha384').update(bytes).digest('base64')}`

// Decide what to do with one artifact whose immutable key may already exist remotely.
//   remoteHash === null      → object absent → 'upload'
//   remoteHash === localHash → identical bytes already published → 'skip' (idempotent; this is how an
//                              interrupted prior publish is completed — only the missing files upload)
//   otherwise                → refuse: the path is immutable and the bytes differ, so overwriting would
//                              silently change what already-cached clients fetch. Throw; bump the version.
export const planUpload = (key, localHash, remoteHash) => {
  if (remoteHash === null) return 'upload'
  if (remoteHash === localHash) return 'skip'
  throw new Error(
    `Refusing to overwrite ${key}: it is already published with different bytes ` +
      `(remote ${remoteHash} ≠ local ${localHash}). CDN paths are immutable — bump the version instead of overwriting.`,
  )
}

// Plan every artifact of a release before any upload happens: for each one, read its local bytes and
// the bytes (if any) already published at its immutable key, then decide upload/skip/abort via
// planUpload. The filesystem and wrangler are injected — `readLocal(name)` → Buffer, or null when the
// build artifact is absent; `fetchRemote(key)` → Buffer, or null when the object is absent — so
// scripts/publish-cdn.lib.test.mjs can drive the whole plan/abort flow with no I/O. Returns one plan
// per artifact, in order, or THROWS (before returning any plan) if a build artifact is missing or an
// immutable path already holds different bytes. Throwing rather than returning partial plans is the
// mechanism behind publish-cdn.mjs's Phase 1 / Phase 2 split: the caller uploads only after this
// returns for EVERY artifact, so a mismatch on artifact N can never leave artifacts 1..N-1 already
// uploaded at immutable, year-cached paths that then cannot be corrected without a version bump.
export const planAll = (artifacts, version, { readLocal, fetchRemote }) =>
  artifacts.map(({ name, contentType }) => {
    const localBytes = readLocal(name)
    if (localBytes === null) throw new Error(`Missing build artifact ${name} — run \`bun run build\` first.`)
    const key = objectKey(version, name)
    const remoteBytes = fetchRemote(key)
    const action = planUpload(key, sriHash(localBytes), remoteBytes === null ? null : sriHash(remoteBytes))
    return { key, name, contentType, size: localBytes.length, action }
  })

// Classify a failed `wrangler r2 object get`. A missing object is expected (→ upload); anything else
// (auth, wrong bucket, network) is fatal, so this must fail CLOSED: an auth/config failure must never
// be read as an absent key. It matches R2's GetObject "not found" signatures — the code-10007 form
// ("The specified key does not exist"/NoSuchKey) and the bare "404: Not Found" that wrangler prints
// for a genuinely-missing object. The bare 404/"not found" tokens are deliberate and load-bearing: on
// a fresh publish every object is legitimately absent, and wrangler may report that only as a generic
// 404, so tightening to key-specific strings would make every new-version publish wrongly abort in
// Phase 1. The accepted tradeoff is a narrow fail-OPEN seam — a non-object 404 (e.g. a misrouted
// request) reads as "absent" → upload — which only risks an immutable overwrite in the rare case that
// the key actually exists with different bytes AND the follow-up put still succeeds (already operator
// error: a re-published version with changed content). Wrangler's real wrong-bucket string ("The
// specified bucket does not exist", code 10006) lacks both "key" and "not found", so it correctly
// stays fatal. NB: these signatures track wrangler's wording — if an upgrade changes the absent-object
// message, re-capture the vectors in the test, or fresh publishes will start failing at Phase 1.
export const isObjectMissing = (stderr = '') =>
  /the specified key does not exist|no such key|nosuchkey|not found|\b404\b|\b10007\b/i.test(stderr)

// True when a version string is a shape we're willing to mint into an immutable, public CDN path
// (cdn.pugs.dev/v<version>/…). Guards against publishing "vundefined/…" from a missing or garbage
// package.json version; it is a path-shape check, NOT full semver validation (the publish never
// compares or ranges versions). Prerelease/build metadata (1.2.0-rc.1, 1.2.0+build) is allowed.
export const isPublishableVersion = version => /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version ?? '')

// wrangler argv to read an object to stdout (--pipe) from the real bucket (--remote), used to probe
// existence and hash the remote bytes for the immutability check.
export const getObjectArgs = (bucket, key) => ['r2', 'object', 'get', `${bucket}/${key}`, '--pipe', '--remote']

// wrangler argv to upload a local file to the real bucket (--remote) with its content type and the
// immutable cache header.
export const putObjectArgs = (bucket, key, file, contentType) => [
  'r2',
  'object',
  'put',
  `${bucket}/${key}`,
  '--file',
  file,
  '--content-type',
  contentType,
  '--cache-control',
  CACHE_CONTROL,
  '--remote',
]
