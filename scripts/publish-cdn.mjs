// Publishes the built CDN bundle to Cloudflare R2 (served at https://cdn.pugs.dev). Run manually on
// release, after `bun run build`, as `bun run scripts/publish-cdn.mjs` (see RELEASING.md). Uploads
// dist/cdn/pug.min.js{,.map,.LEGAL.txt} to <bucket>/vX.Y.Z/ with an immutable one-year cache header.
//
// Paths are immutable: for each artifact this reads back any object already at the key and compares
// its SHA-384 hash — identical → skip (so an interrupted publish is finished by uploading only the
// missing files), different → abort before uploading anything (bump the version rather than
// overwrite). The plan-everything-then-upload split lives in planAll (publish-cdn.lib.mjs) so a
// mismatch on any artifact aborts before a single upload; its test pins that ordering guarantee. It
// reprints the SRI, now guaranteed to match the live pug.min.js.
//
// Runs under plain node or bun. wrangler is invoked via `bunx wrangler` by default (override with
// WRANGLER_BIN, e.g. `WRANGLER_BIN=wrangler` or `WRANGLER_BIN="npx wrangler"`); the bucket defaults
// to `pugs-dev-cdn` (override with PUG_CDN_BUCKET). EVERY wrangler call carries --remote — without it the
// R2 commands hit local miniflare storage and the publish silently does nothing.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  CDN_ARTIFACTS,
  getObjectArgs,
  isObjectMissing,
  isPublishableVersion,
  planAll,
  putObjectArgs,
  sriHash,
} from './publish-cdn.lib.mjs'

const DIST_DIR = 'dist/cdn'
const bucket = process.env.PUG_CDN_BUCKET ?? 'pugs-dev-cdn'
const [wranglerBin, ...wranglerPrefix] = (process.env.WRANGLER_BIN ?? 'bunx wrangler').split(' ')

const fail = message => {
  console.error(message)
  process.exit(1)
}

// Run wrangler with the configured binary. Returns raw stdout (Buffer — object bytes for `get`) and
// stderr (string). A spawn error (e.g. the binary is not installed) is surfaced as a fatal message.
const runWrangler = args => {
  const res = spawnSync(wranglerBin, [...wranglerPrefix, ...args], {
    maxBuffer: 64 * 1024 * 1024, // the sourcemap is ~600 KB; give plenty of headroom
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
  if (res.error) fail(`Could not run "${wranglerBin}" — is wrangler installed? (${res.error.message})`)
  return {
    status: res.status,
    stdout: res.stdout ?? Buffer.alloc(0),
    stderr: (res.stderr ?? Buffer.alloc(0)).toString(),
  }
}

// The remote bytes at a key, or null if the object does not exist. Any other read failure is fatal.
const fetchRemote = key => {
  const { status, stdout, stderr } = runWrangler(getObjectArgs(bucket, key))
  if (status === 0) return stdout
  if (isObjectMissing(stderr)) return null
  fail(`Could not read ${bucket}/${key} from R2:\n${stderr}`)
}

let version
try {
  version = JSON.parse(readFileSync('package.json', 'utf8')).version
} catch (err) {
  fail(`Could not read package.json (run this from the repo root): ${err.message}`)
}
// This version becomes an immutable, publicly-loaded path (cdn.pugs.dev/v<version>/…); refuse a missing
// or malformed one here rather than publish "vundefined/…" (isPublishableVersion is pinned in the lib test).
if (!isPublishableVersion(version)) {
  fail(`package.json version ${JSON.stringify(version)} is not valid semver — refusing to publish.`)
}

if (!existsSync(`${DIST_DIR}/pug.min.js`)) {
  fail(`No build at ${DIST_DIR}/pug.min.js — run \`bun run build\` first.`)
}

console.log(`Publishing v${version} to R2 bucket "${bucket}" (remote)…`)

// Phase 1: read back every artifact and decide upload/skip/abort. planAll throws on an immutable-path
// content mismatch (or a missing build artifact), so a differing byte on ANY artifact aborts here —
// before Phase 2 runs a single upload.
let plans
try {
  plans = planAll(CDN_ARTIFACTS, version, {
    readLocal: name => {
      const localPath = `${DIST_DIR}/${name}`
      return existsSync(localPath) ? readFileSync(localPath) : null
    },
    fetchRemote,
  })
} catch (err) {
  fail(err.message)
}

// Phase 2: upload only the artifacts that are absent.
let uploaded = 0
for (const { key, name, contentType, size, action } of plans) {
  if (action === 'skip') {
    console.log(`  skip    ${key} (identical bytes already published)`)
    continue
  }
  const put = runWrangler(putObjectArgs(bucket, key, `${DIST_DIR}/${name}`, contentType))
  if (put.status !== 0) fail(`Failed to upload ${bucket}/${key}:\n${put.stderr}`)
  console.log(`  upload  ${key} (${size} B, ${contentType})`)
  uploaded++
}

console.log(`\nDone: ${uploaded} uploaded, ${plans.length - uploaded} unchanged.`)
console.log(`URL  https://cdn.pugs.dev/v${version}/pug.min.js`)
console.log(`SRI  ${sriHash(readFileSync(`${DIST_DIR}/pug.min.js`))}`)
