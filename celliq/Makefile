# CellIQ — WorkIQ house Makefile
BUN  := $(HOME)/.bun/bin/bun
PORT ?= 8787
PIDF := local/.server.pid

.PHONY: celld-oss-up edge-up edge-down celld-dev celld-image celld-up celld-local-up celld-down celld-deploy celld-logs install verify test check dev seed db-generate web-install web-build docs-build web-dev dev-edge local-up local-down local-status deploy clean

install:      ## install root + web + docs deps
	@$(BUN) install
	@cd web && $(BUN) install
	@cd docs && $(BUN) install
verify:       ; $(BUN) run verify           ## tsc --noEmit on the runtime-agnostic core
test:         ; $(BUN) test                 ## bun test (repo + api + zod)
check: verify test                          ## the gate: types + tests
dev:          ; PORT=$(PORT) $(BUN) run src/index.ts
seed:         ; $(BUN) run src/seed.ts       ## insert fixture data into local db
db-generate:  ; $(BUN) run db:generate      ## schema -> forward-only migration
web-install:  ; cd web && $(BUN) install
web-build:    ; cd web && $(BUN) run build
docs-build:   ; cd docs && $(BUN) run build   ## build the Starlight docs site
web-dev:      ; cd web && API=http://localhost:$(PORT) $(BUN) run dev
dev-edge:     ; cd cloudflare && $(BUN) x wrangler dev   ## workerd/miniflare edge parity

local-up:     ## flock-locked, signal-managed local server (bun:sqlite)
	@mkdir -p local
	@if [ -f $(PIDF) ] && kill -0 $$(cat $(PIDF)) 2>/dev/null; then echo "already up ($$(cat $(PIDF)))"; else \
	  setsid bash local/run.sh >local/server.log 2>&1 & fi
	@for i in $$(seq 1 40); do curl -sf http://localhost:$(PORT)/api/health >/dev/null 2>&1 && break || sleep 0.25; done
	@echo "health: $$(curl -s http://localhost:$(PORT)/api/health)"

local-down:   ; @[ -f $(PIDF) ] && kill -TERM $$(cat $(PIDF)) 2>/dev/null && echo "SIGTERM $$(cat $(PIDF))" || echo "not running"
local-status: ; @[ -f $(PIDF) ] && kill -0 $$(cat $(PIDF)) 2>/dev/null && echo "UP $$(cat $(PIDF))" || echo "DOWN"
deploy:       ; $(BUN) run deploy
clean:        ; rm -rf node_modules web/node_modules local/*.db local/*.db-* .wrangler dist web/dist

# ---- celld (self-hosted Workers runtime) --------------------------------------------------
CELLD   ?= $(HOME)/.local/bin/celld
COMPOSE := docker compose -f deploy/celld/compose.yml
IMAGE   ?= celliq-celld:latest
CA_SECRET = $(if $(CA),--secret id=extra_ca$(comma)src=$(CA))
comma := ,
celld-dev:      web-build   ## one local celld node + local object store on :9876 (no Docker, no bucket)
	CELLD_ESBUILD=$(CURDIR)/node_modules/esbuild/bin/esbuild $(CELLD) dev --port 9876
celld-image:    ## build the node image (gate + static web + celld) — BUILD_SHA=... CA=/path/ca.crt optional
	docker buildx build --load $(CA_SECRET) --build-arg BUILD_SHA=$${BUILD_SHA:-$$(git rev-parse --short HEAD 2>/dev/null || echo dev)} -t $(IMAGE) .
celld-up:       ## deploy + 2-node fleet + lb against the bucket in deploy/celld/.env
	$(COMPOSE) up -d --build
celld-local-up: ## same, with a bundled SeaweedFS bucket (dev/test)
	$(COMPOSE) --profile local-s3 up -d s3 s3-init && $(COMPOSE) --profile local-s3 up -d --build
celld-deploy:   ## publish a new version; running nodes adopt it without a restart
	$(COMPOSE) run --rm deploy
celld-logs:     ; $(COMPOSE) logs -f --tail=100 node-a node-b
celld-down:     ; $(COMPOSE) --profile local-s3 --profile tunnel --profile oss-tunnel down
celld-oss-up:   ## fleet + lb + frpc tunnel to the open-source edge (deploy/oss)
	$(COMPOSE) --profile oss-tunnel up -d --build
EDGE := docker compose -f deploy/oss/compose.edge.yml --env-file deploy/oss/.env.edge
edge-up:        ## open-source edge: Caddy + caddy-security + frps (run on the public VPS)
	@test -f deploy/oss/edge/jwt/sign.pem || sh deploy/oss/keygen.sh
	$(EDGE) up -d --build
edge-down:      ; $(EDGE) down
