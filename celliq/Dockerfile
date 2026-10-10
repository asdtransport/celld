# syntax=docker/dockerfile:1.7
# CellIQ on celld — one image that builds the WorkIQ app and runs it on a celld node.
#
#   docker build -t celliq-celld .
#   docker run ... celliq-celld            # serve (deploys first when CELLD_DEPLOY=1)
#   docker run ... celliq-celld deploy     # one-shot: publish the bundle to the fleet bucket
#   docker run ... celliq-celld celld d1 migrations apply celliq /app   # any celld subcommand
#
# Behind a TLS-intercepting proxy, pass its CA as a build secret (never baked into the image):
#   docker build --secret id=extra_ca,src=/path/ca-bundle.crt -t celliq-celld .

ARG BUN_IMAGE=oven/bun:1
ARG CELLD_IMAGE=ghcr.io/denoland/celld:0.6.2

# ---------- build: deps, gate, static web ----------
FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json web/bun.lock ./web/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    bun install --frozen-lockfile && (cd web && bun install --frozen-lockfile)
COPY . .
# The gate runs inside the build: a red typecheck or test never becomes an image.
RUN bun run verify && bun test
RUN cd web && bun run build && test -f dist/index.html
# The native esbuild that `celld deploy` shells out to (arch-matched by the build platform).
RUN mkdir -p /out && cp "$(find node_modules/@esbuild -path '*/bin/esbuild' -type f | head -1)" /out/esbuild && /out/esbuild --version
# Runtime deps only: celld bundles cloudflare/worker/index.ts from these at deploy time.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    rm -rf node_modules && bun install --frozen-lockfile --production

# ---------- runtime: celld + the deployable project ----------
FROM ${CELLD_IMAGE}
ARG BUILD_SHA=dev
LABEL org.opencontainers.image.title="celliq-celld" \
      org.opencontainers.image.description="CellIQ (WorkIQ) on the celld self-hosted Workers runtime" \
      org.opencontainers.image.revision="${BUILD_SHA}"
RUN apt-get update && apt-get install -y --no-install-recommends curl tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/esbuild /usr/local/bin/esbuild
COPY --from=build /app/package.json /app/wrangler.jsonc ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/cloudflare/worker ./cloudflare/worker
COPY --from=build /app/cloudflare/migrations ./cloudflare/migrations
COPY --from=build /app/web/dist ./web/dist
COPY deploy/celld/entrypoint.sh /usr/local/bin/celliq-entrypoint
RUN chmod +x /usr/local/bin/celliq-entrypoint && mkdir -p /var/lib/celld

ENV BUILD_SHA=${BUILD_SHA} \
    CELLD_ESBUILD=/usr/local/bin/esbuild \
    CELLD_ADDR=0.0.0.0:8787 \
    CELLD_INTERNAL_ADDR=0.0.0.0:8788 \
    CELLD_WATCH=/var/lib/celld/state \
    CELLD_ASSET_CACHE_DIR=/var/lib/celld/assets \
    AWS_REGION=auto
VOLUME ["/var/lib/celld"]
EXPOSE 8787 8788
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/api/health >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/celliq-entrypoint"]
CMD ["serve"]
