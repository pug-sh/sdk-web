// Builds the CDN IIFE bundle from src/cdn.ts into dist/cdn/pug.min.js plus a sourcemap with the
// sources inlined (src/ is not shipped, so the map is the readable form of the bundle). It lives
// under dist/cdn/ because tsc emits dist/pug.js from src/pug.ts — a root-level bundle would
// overwrite that module and break the ESM package. Runs as part of `bun run build` and must stay
// plain node — `npm publish` executes prepublishOnly under node, not bun. Prints the bundle's raw
// and gzip sizes plus its SRI hash, and fails the build when gzip exceeds the size budget so a
// dependency regression cannot ship silently; raising the budget is a deliberate, reviewable
// change to the constant below. Also writes a pug.min.js.LEGAL.txt sidecar attributing every
// bundled runtime dependency (Apache-2.0 §4 attribution), shipped via the package `files` allowlist.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { backfillLegalNotices } from './legal.mjs'
import { sriHash } from './publish-cdn.lib.mjs'

const GZIP_BUDGET_KB = 45

const { name, version, homepage, dependencies } = JSON.parse(readFileSync('package.json', 'utf8'))

await build({
  entryPoints: ['src/cdn.ts'],
  bundle: true,
  format: 'iife', // no globalName — src/cdn.ts installs window.pug itself
  platform: 'browser',
  target: ['es2020'], // matches tsconfig
  legalComments: 'linked', // extract bundled deps' license notices to pug.min.js.LEGAL.txt (Apache-2.0 attribution)
  banner: { js: `/*! ${name} v${version} | MIT License | ${homepage} */` },
  minify: true,
  sourcemap: true,
  outfile: 'dist/cdn/pug.min.js',
})

// esbuild's 'linked' mode extracts inline license banners (e.g. uuidv7's) into the sidecar, but a
// dependency that ships no inline banner (@bufbuild/protobuf) is missed. Backfill every runtime
// dependency absent from the extracted notices so each bundled package is attributed; see
// scripts/legal.mjs for the deliberate substring-dedup rationale (scripts/legal.test.mjs pins it).
const legalPath = 'dist/cdn/pug.min.js.LEGAL.txt'
const extractedLegal = existsSync(legalPath) ? readFileSync(legalPath, 'utf8') : 'Bundled license information:\n'
const legal = backfillLegalNotices(extractedLegal, dependencies, dep =>
  JSON.parse(readFileSync(`node_modules/${dep}/package.json`, 'utf8')),
)
writeFileSync(legalPath, legal)

const min = readFileSync('dist/cdn/pug.min.js')
const gzipBytes = gzipSync(min, { level: 9 }).length
const sri = sriHash(min)
console.log(`dist/cdn/pug.min.js  ${min.length} B raw  ${gzipBytes} B gzip  SRI ${sri}`)

if (gzipBytes > GZIP_BUDGET_KB * 1024) {
  console.error(`CDN bundle exceeds the size budget: ${gzipBytes} B gzip > ${GZIP_BUDGET_KB} KB.`)
  process.exit(1)
}
