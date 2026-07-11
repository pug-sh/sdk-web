// Attribution backfill for the CDN bundle's LEGAL.txt sidecar (Apache-2.0 §4). esbuild's 'linked'
// mode extracts the inline license banner of any dependency that ships one (e.g. uuidv7), but a
// dependency with no inline banner (@bufbuild/protobuf) is missed. This appends an entry for every
// runtime dependency esbuild did not already attribute.
//
// The `legal.includes(dep)` guard is deliberately a plain substring check, NOT a boundary-anchored
// `^<dep> v` match. esbuild formats an extracted banner by source path (`uuidv7/dist/index.js:`) and
// names the package only inside the banner body — never as a `<dep> v<version>:` header — so an
// anchored match would miss esbuild's uuidv7 banner and append a DUPLICATE uuidv7 block. The
// two-package runtime dep set has no substring collision, so containment is safe and correct here.
// scripts/legal.test.mjs pins both properties so the anchored-regex regression cannot be reintroduced.
export const backfillLegalNotices = (legal, dependencies, readPkg) => {
  for (const dep of Object.keys(dependencies).sort()) {
    if (legal.includes(dep)) continue
    const meta = readPkg(dep)
    const url = meta.homepage ?? (typeof meta.repository === 'string' ? meta.repository : meta.repository?.url) ?? ''
    legal += `\n${dep} v${meta.version}:\n  License: ${meta.license}\n${url ? `  ${url}\n` : ''}`
  }
  return legal
}
