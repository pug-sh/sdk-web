import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Post-processes `buf generate` output in src/gen to drop the buf/validate dependency.
//
// The pug protos carry `(buf.validate.*)` field options, so protoc-gen-es imports the
// buf/validate/validate_pb descriptor (~73 KB minified) and lists it in each fileDesc()
// deps array. But the SDK no longer validates client-side (protovalidate was removed), and
// protobuf-es's fileDesc() OVERWRITES the descriptor's dependency list from the deps arg —
// buf.validate is referenced only via field *options* (extensions stored as unknown fields),
// never as a field type, so the registry never needs it. Removing the import + deps entry
// therefore keeps create()/toBinary()/fromBinary() byte-identical while dropping validate_pb
// from the bundle. The option bytes remain in the embedded descriptor as harmless unknowns.
//
// Runs as part of `make protos` (after `buf generate`), so it survives proto bumps.

const __dirname = dirname(fileURLToPath(import.meta.url))
const genRoot = join(__dirname, '..', 'src', 'gen')
const IMPORT = 'file_buf_validate_validate'

const walk = dir => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      walk(p)
    } else if (p.endsWith('.ts')) {
      stripFile(p)
    }
  }
}

let touched = 0
const stripFile = path => {
  const src = readFileSync(path, 'utf8')
  if (!src.includes(IMPORT)) return
  const out = src
    // Drop the import line: `import { file_buf_validate_validate } from ".../validate_pb.js";`
    .replace(new RegExp(`^import \\{ ${IMPORT} \\} from "[^"]*validate_pb\\.js";\\n`, 'm'), '')
    // Drop it from the fileDesc() deps array in every position — sole, first, middle, or last.
    // buf/validate sorts first in generated deps today, but don't depend on that ordering. The
    // lookahead on the non-first case matches `, IMPORT` only when it's followed by `,` or `]`,
    // so it removes a whole element without clipping a longer identifier that merely starts with it.
    .replace(new RegExp(`\\[${IMPORT}\\]`, 'g'), '[]')
    .replace(new RegExp(`\\[${IMPORT}, `, 'g'), '[')
    .replace(new RegExp(`, ${IMPORT}(?=[,\\]])`, 'g'), '')
  if (out !== src) {
    writeFileSync(path, out)
    touched++
  }
}

walk(genRoot)

// Remove the now-orphaned buf/validate descriptor entirely. src/gen/buf/ holds nothing
// else, so drop the whole tree.
rmSync(join(genRoot, 'buf'), { recursive: true, force: true })

console.log(`Stripped buf/validate dependency from ${touched} generated file(s); removed src/gen/buf/validate.`)
