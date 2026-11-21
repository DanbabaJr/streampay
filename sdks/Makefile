PYTHON ?= python3
VECTORS_BUILDER := vectors/builder
TS_DIR := typescript

.PHONY: help spec generate check check-spec vectors test publish-dry-run clean conformance conformance-test conformance-live mobile-check mobile-bindings

help:
	@echo "spec              re-derive spec/streampay.spec.json + FINGERPRINT from the contract"
	@echo "generate          run every language emitter whose package is present"
	@echo "check             schema guard + spec/vector/catalog tests + generated-output drift"
	@echo "check-spec        schema guard + tests only"
	@echo "vectors           rebuild conformance vectors (deterministic)"
	@echo "test              TypeScript SDK: typecheck, build, tests (incl. vectors)"
	@echo "conformance       TypeScript + Rust + Python decode every shared vector"
	@echo "conformance-test  orchestrator lifecycle tests (no Docker/network)"
	@echo "conformance-live  same clients against an ephemeral Stellar sandbox"
	@echo "mobile-bindings   regenerate UDL + 99-code catalog + manifest"
	@echo "mobile-check      freshness gate + host tests + host vector runner"
	@echo "publish-dry-run   npm pack --dry-run for the TypeScript SDK (no upload)"

spec:
	$(PYTHON) generator/check_contract_surface.py --write-spec

generate:
	$(PYTHON) generator/generate.py

check-spec:
	$(PYTHON) generator/check_contract_surface.py
	$(PYTHON) -m unittest discover -s generator -p "test_*.py" -v

check: check-spec
	$(PYTHON) generator/generate.py --check

vectors:
	cd $(VECTORS_BUILDER) && npm ci && node build-vectors.mjs

test:
	cd $(TS_DIR) && npm ci && npm run typecheck && npm test

conformance:
	./conformance/run.sh

conformance-test:
	$(PYTHON) -m unittest discover -s conformance -p "test_*.py" -v

conformance-live:
	./conformance/run.sh --live --sandbox "$(PYTHON) conformance/sandbox.py"

mobile-bindings:
	node mobile/scripts/generate-bindings.mjs

mobile-check:
	node mobile/scripts/generate-bindings.mjs --check
	cargo test --manifest-path mobile/Cargo.toml
	cargo run --manifest-path mobile/Cargo.toml --bin streampay-mobile-conformance -- vectors

publish-dry-run:
	cd $(TS_DIR) && npm pack --dry-run

clean:
	rm -rf $(TS_DIR)/dist $(TS_DIR)/*.tgz
