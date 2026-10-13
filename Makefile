# Vapor: shortcuts for the desktop app and the usual checks.
#   make          show this help
#   make dev      run the desktop app (installs frontend deps first, hot reload)
#
# pnpm is found automatically; if the `pnpm` on your PATH does not work (a broken corepack shim
# is common on Windows) the Makefile falls back to `npx -y pnpm@10`. Override with PNPM=...

PNPM ?= $(shell pnpm --version >/dev/null 2>&1 && echo pnpm || echo npx -y pnpm@10)
CARGO ?= cargo
BACKEND := backend/Cargo.toml

.DEFAULT_GOAL := help
.PHONY: help dev run install build bundle test check validate index audit-deps clean

help: ## show this help
	@echo "Vapor targets:"
	@grep -hE '^[a-zA-Z_ -]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-11s %s\n", $$1, $$2}'
	@echo ""
	@echo "pnpm command in use: $(PNPM)"

install: ## install frontend dependencies
	$(PNPM) install --frozen-lockfile

dev run: install ## run the desktop app (Tauri dev window, hot reload)
	$(PNPM) tauri dev

build: install ## build the frontend (tsc + vite)
	$(PNPM) build

bundle: install ## build the installable desktop app (release)
	$(PNPM) tauri build

test: ## run all tests (Rust workspace + tool tests)
	$(CARGO) test --workspace
	node --test tools/crawler/license-audit.test.mjs tools/links/check.test.mjs

check: build ## everything CI checks: tests, catalog validation, backend compile
	$(CARGO) test --workspace
	$(CARGO) run -q -p vapor-cli -- validate .
	$(CARGO) check --manifest-path $(BACKEND)

validate: ## validate games/, links/, audits/ and the takedown blocklist
	$(CARGO) run -q -p vapor-cli -- validate .

index: ## generate catalog.json from games/ and links/
	$(CARGO) run -q -p vapor-cli -- index .

audit-deps: ## audit Rust and npm dependencies (needs: cargo install cargo-audit)
	$(CARGO) audit
	$(CARGO) audit --file backend/Cargo.lock
	$(PNPM) audit --prod

clean: ## remove build outputs (dist, cargo target dirs)
	rm -rf dist target backend/target
