# Releasing

Publishing is manual. A release ships **two** things:

- the **npm package** (`npm publish`) — for `npm install` / bundler users; jsDelivr also serves it from npm as a fallback.
- the **CDN bundle** to **`cdn.pugs.dev`** (first-party Cloudflare R2) — the URL the documented `<script>` installs point at: `https://cdn.pugs.dev/vX.Y.Z/pug.min.js`. It's an **`@`-free, version-in-path** URL on purpose: a `pkg@version` substring in a customer's HTML matches Cloudflare Email Address Obfuscation and gets rewritten to `[email protected]`, breaking the load — the path form avoids that on every customer's Cloudflare zone.

## One-time setup (Cloudflare)

1. Create the R2 bucket (default `pugs-dev-cdn`; override with `PUG_CDN_BUCKET`): `bunx wrangler r2 bucket create pugs-dev-cdn`.
2. Attach the custom domain: R2 → `pugs-dev-cdn` → Settings → **Custom Domains** → add `cdn.pugs.dev` (Cloudflare creates the proxied DNS record + edge cert automatically).
3. **Only if** you want integrators to use `integrity`/`crossorigin`: add a bucket **CORS** rule allowing `Access-Control-Allow-Origin: *`. A plain `<script src>` needs no CORS.
4. `bunx wrangler login` (or a `CLOUDFLARE_API_TOKEN` with R2 write) so the publish step is authenticated.

## Each release

1. **Bump the version** in `package.json` (semver; pre-1.0 minors may break).
2. **Update the pinned snippet URLs** in `README.md` (`cdn.pugs.dev/vX.Y.Z/pug.min.js`) — enforced: the test suite fails if any pinned URL differs from `package.json`'s version. While pre-1.0 the documented snippet pins exact versions; at 1.0 switch the docs to a rolling major alias (`cdn.pugs.dev/v1/…`) and this step mostly goes away.
3. **Build**: `bun run build`. The `prebuild` hook stamps `src/version.ts`, tsc compiles `dist/`, and `scripts/build-cdn.mjs` bundles `dist/cdn/pug.min.js`, printing its size and SRI hash — **record the SRI line** for the release notes. The build fails if the bundle exceeds the gzip budget (`GZIP_BUDGET_KB` in `scripts/build-cdn.mjs`, 45).
4. **Check**: `bun run test && bun run lint`.
5. **Commit** as `Release vX.Y.Z` — must include `package.json` and the restamped `src/version.ts` (CI has a drift gate on it) and the doc URL bumps. Tag `vX.Y.Z` and push with tags.
6. **Publish the package**: `npm publish` (auth token in `~/.npmrc`; `prepublishOnly` rebuilds everything).
7. **Publish the CDN bundle**: `bun run scripts/publish-cdn.mjs` — uploads `dist/cdn/pug.min.js{,.map,.LEGAL.txt}` to `pugs-dev-cdn/vX.Y.Z/` (via `wrangler … --remote`) with a one-year immutable cache header. Paths are immutable, so it hashes any already-present object and **aborts if the bytes differ** from the local build (bump the version rather than overwrite); an interrupted prior publish is completed by uploading only the missing files. It reprints the SRI — now guaranteed to match the live `pug.min.js`. (Run `bun run build` first if you haven't this session.)
8. **Verify the CDN**: `curl -I https://cdn.pugs.dev/vX.Y.Z/pug.min.js` — expect `200`, `content-type: text/javascript`, and an `immutable` `cache-control`. If paranoid, confirm the served hash matches the recorded SRI: `curl -s https://cdn.pugs.dev/vX.Y.Z/pug.min.js | openssl dgst -sha384 -binary | base64`. (jsDelivr fallback URL: `curl -I https://cdn.jsdelivr.net/npm/@pug-sh/browser@X.Y.Z/dist/cdn/pug.min.js`.)
9. **Release notes**: create a GitHub release for the tag; include the `https://cdn.pugs.dev/vX.Y.Z/pug.min.js` URL and the `sha384-…` SRI so strict-CSP integrators can pin it.

Immutable, version-pinned paths need no cache purge. (A rolling alias — `/v1/`, once the docs use one post-1.0 — would: publish it separately with a short cache and purge on each release.)

Future (deliberately not built yet): a tag-triggered GitHub Action that runs both publishes — npm trusted publishing plus `scripts/publish-cdn.mjs` with a scoped R2 token — automating steps 6–9.
