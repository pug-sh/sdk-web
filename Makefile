# pug-web developer tasks. Mirrors sdk-android / sdk-flutter proto vendoring: the
# published package carries generated code (src/gen), so consumers just `npm install`
# with no Buf Schema Registry entry in their .npmrc.

.PHONY: sync-protos protos typed-events check-codegen check-proto-pin proto-latest build lint test check ci

# BSR module + pinned commit that proto/ is vendored from. The pin makes `make sync-protos`
# reproducible and makes taking newer upstream protos a deliberate, reviewable change —
# builds and CI never touch BSR (proto/ + src/gen are committed). To bump: run
# `make proto-latest` for the newest commit, set PROTO_COMMIT below, then
# `make sync-protos && make protos` and review + commit the diff.
# RELEASE BLOCKER: proto/sdk/events/v1/events.proto is hand-patched ahead of the
# BSR (cookieless field, pug repo branch feat/cookieless-identity). Before any
# npm/CDN release: merge that branch, run `make proto-latest`, bump PROTO_COMMIT,
# `make sync-protos && make protos`, and confirm the sync produces no diff.
PROTO_MODULE  := buf.build/pugsh/pug
PROTO_COMMIT  := 739d784162d649a3be748db76d3fafd8

# Re-vendor proto/ from the pinned BSR commit. `buf export` is a read-only download; --path is
# an allowlist and buf pulls in transitive imports (buf/validate, google WKTs) automatically,
# so backend-only trees (shared/**, dashboard/**, public/**, workers/**) and the unused
# common/v1 filter/time protos are never synced. Add a --path when the SDK consumes a new package.
sync-protos:
	@command -v buf >/dev/null || { echo "buf CLI required: https://buf.build/docs/installation"; exit 1; }
	rm -rf proto
	buf export $(PROTO_MODULE):$(PROTO_COMMIT) --output proto \
	  --path sdk \
	  --path common/events/v1 \
	  --path common/v1/property_value.proto
	@echo "Synced SDK protos into proto/ at $(PROTO_COMMIT). Run 'make protos' to regenerate src/gen."

# Print the newest commit on the module's main branch, to update PROTO_COMMIT above.
proto-latest:
	@buf registry module commit resolve $(PROTO_MODULE):main

# Release gate for the RELEASE BLOCKER above: proves proto/ is exactly what the pinned BSR commit
# exports, i.e. that nothing is hand-patched ahead of the pin.
#
# Nothing else in the repo can detect that divergence. `make check-codegen` runs `make protos`
# against the *committed* mirror and diffs src/gen, so a hand-patched proto/ regenerates
# consistently and stays green — CI is structurally incapable of noticing. Only re-downloading from
# BSR and diffing can, which is why this is a separate target: it needs network access, so it runs
# at publish time rather than on every CI run.
#
# While the blocker stands this target FAILS BY DESIGN. That is the point — it converts a comment
# nobody is obliged to read into a step `npm publish` cannot skip.
check-proto-pin:
	@command -v buf >/dev/null || { echo "buf CLI required: https://buf.build/docs/installation"; exit 1; }
	@rm -rf .proto-pin-check
	@buf export $(PROTO_MODULE):$(PROTO_COMMIT) --output .proto-pin-check \
	  --path sdk \
	  --path common/events/v1 \
	  --path common/v1/property_value.proto
	@if diff -r -q proto .proto-pin-check >/dev/null 2>&1; then \
	  rm -rf .proto-pin-check; \
	  echo "proto/ matches $(PROTO_MODULE):$(PROTO_COMMIT) — safe to release."; \
	else \
	  echo ""; \
	  echo "RELEASE BLOCKED: proto/ diverges from the pinned BSR commit $(PROTO_COMMIT)."; \
	  echo ""; \
	  diff -r proto .proto-pin-check || true; \
	  rm -rf .proto-pin-check; \
	  echo ""; \
	  echo "proto/ is hand-patched ahead of the pin. Merge the backend branch, then:"; \
	  echo "  make proto-latest             # newest commit on main"; \
	  echo "  \# update PROTO_COMMIT in the Makefile"; \
	  echo "  make sync-protos && make protos"; \
	  echo "and re-run this target until it is clean. Publishing now would ship generated code"; \
	  echo "for a wire contract the backend has not agreed to."; \
	  exit 1; \
	fi

# Regenerate committed protobuf-es TypeScript from the vendored proto/ mirror, then
# refresh the typed track() surface derived from it. protoc-gen-es is a devDependency,
# resolved from node_modules/.bin.
protos:
	@command -v buf >/dev/null || { echo "buf CLI required: https://buf.build/docs/installation"; exit 1; }
	PATH="$(CURDIR)/node_modules/.bin:$$PATH" buf generate
	node scripts/strip-validate-deps.mjs
	$(MAKE) typed-events

# Rebuild the well-known-event artifacts from the generated schemas: the type-only
# registry (src/well-known-events.generated.ts) and the human reference
# (WELL_KNOWN_EVENTS.md). Web analog of sdk-flutter's typed-track. The script introspects
# a throwaway compile of src/gen (node can't import the .ts source directly), so nothing
# here touches the Buf Schema Registry.
typed-events:
	node_modules/.bin/tsc -p tsconfig.gen.json
	node scripts/gen-well-known-events.mjs
	rm -rf .codegen-tmp

# CI gate: committed codegen (src/gen + typed events + the reference doc) must match a
# fresh generate. Depends on `protos` (not just `typed-events`) so a standalone
# `make check-codegen` also regenerates src/gen; otherwise src/gen drift passes unchecked
# here while the real GitHub CI (which diffs all paths) fails. buf.gen.yaml's clean:true
# means a stale src/gen would otherwise be silently overwritten with no drift reported.
check-codegen: protos
	@git diff --exit-code -- src/gen src/well-known-events.generated.ts WELL_KNOWN_EVENTS.md \
	  || { echo "codegen drift — run 'make protos' and commit"; exit 1; }

build:
	bun run build
lint:
	bun run lint
test:
	bun run test

check: lint test build
# Strict CI target: regenerate protobufs from scratch, then run every check.
ci: protos check-codegen check
