# FleetIQ — WorkIQ house Makefile
BUN  := $(HOME)/.bun/bin/bun
PORT ?= 8787
PIDF := local/.server.pid

.PHONY: install verify test check dev db-generate web-install web-build docs-build web-dev local-up local-down local-status image clean

install:      ## install root + web + docs deps
	@$(BUN) install
	@cd web && $(BUN) install
	@cd docs && $(BUN) install
verify:       ; $(BUN) run verify           ## tsc --noEmit on the runtime-agnostic core
test:         ; $(BUN) test                 ## bun test (repo + api + zod)
check: verify test                          ## the gate: types + tests
dev:          ; PORT=$(PORT) $(BUN) run src/index.ts
db-generate:  ; $(BUN) run db:generate      ## schema -> forward-only migration
web-install:  ; cd web && $(BUN) install
web-build:    ; cd web && $(BUN) run build
docs-build:   ; cd docs && $(BUN) run build   ## build the Starlight docs site
web-dev:      ; cd web && API=http://localhost:$(PORT) $(BUN) run dev

local-up:     ## flock-locked, signal-managed local server (bun:sqlite)
	@mkdir -p local
	@if [ -f $(PIDF) ] && kill -0 $$(cat $(PIDF)) 2>/dev/null; then echo "already up ($$(cat $(PIDF)))"; else \
	  setsid bash local/run.sh >local/server.log 2>&1 & fi
	@for i in $$(seq 1 40); do curl -sf http://localhost:$(PORT)/api/health >/dev/null 2>&1 && break || sleep 0.25; done
	@echo "health: $$(curl -s http://localhost:$(PORT)/api/health)"

local-down:   ; @[ -f $(PIDF) ] && kill -TERM $$(cat $(PIDF)) 2>/dev/null && echo "SIGTERM $$(cat $(PIDF))" || echo "not running"
local-status: ; @[ -f $(PIDF) ] && kill -0 $$(cat $(PIDF)) 2>/dev/null && echo "UP $$(cat $(PIDF))" || echo "DOWN"
image:        ## build the FleetIQ image (CA=/path/ca.crt behind a TLS proxy)
	docker buildx build --load $(if $(CA),--secret id=extra_ca$(comma)src=$(CA)) --build-arg BUILD_SHA=$${BUILD_SHA:-dev} -t fleetiq:latest .
comma := ,
clean:        ; rm -rf node_modules web/node_modules local/*.db local/*.db-* .wrangler dist web/dist
