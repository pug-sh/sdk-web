# Releasing

Publishing is manual. A release ships the npm package **and** the CDN bundle — jsDelivr serves whatever lands on npm, so `npm publish` is the whole CDN deploy.

1. **Bump the version** in `package.json` (semver; pre-1.0 minors may break).
2. **Update the pinned snippet URLs** in `README.md` (`@pug-sh/browser@X.Y.Z`) — enforced: the test suite fails if any pinned URL differs from `package.json`'s version. While pre-1.0 the documented snippet pins exact versions; at 1.0 switch the docs to the rolling `@1` alias and this step mostly goes away.
3. **Build**: `bun run build`. The `prebuild` hook stamps `src/version.ts`, tsc compiles `dist/`, and `scripts/build-cdn.mjs` bundles `dist/cdn/pug.min.js`, printing its size and SRI hash — **record the SRI line** for the release notes. The build fails if the bundle exceeds the gzip budget (`GZIP_BUDGET_KB` in `scripts/build-cdn.mjs`, 45).
4. **Check**: `bun run test && bun run lint`.
5. **Commit** as `Release vX.Y.Z` — must include `package.json` and the restamped `src/version.ts` (CI has a drift gate on it) and the doc URL bumps. Tag `vX.Y.Z` and push with tags.
6. **Publish**: `npm publish` (auth token in `~/.npmrc`; `prepublishOnly` rebuilds everything).
7. **Verify the CDN**: `curl -I https://cdn.jsdelivr.net/npm/@pug-sh/browser@X.Y.Z/dist/cdn/pug.min.js` — exact-version URLs are live immediately and immutable. Check the served file's hash matches the recorded SRI if you're paranoid: `curl -s <url> | openssl dgst -sha384 -binary | base64`.
8. **Purge rolling aliases** (only relevant once docs point at `@1`): https://www.jsdelivr.com/tools/purge — alias URLs are edge-cached for up to 7 days otherwise.
9. **Release notes**: create a GitHub release for the tag; include the CDN URL and the `sha384-…` SRI hash so strict-CSP integrators can pin it.

Future (deliberately not built yet): a tag-triggered GitHub Action using npm trusted publishing to automate steps 6–9.
