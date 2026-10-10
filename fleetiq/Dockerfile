# syntax=docker/dockerfile:1.7
# FleetIQ — control plane for celld fleets. Bun API + the Astro console, plus the celld CLI.
#   docker build -t fleetiq .     (behind a TLS proxy: --secret id=extra_ca,src=/path/ca.crt)
ARG BUN_IMAGE=oven/bun:1
ARG CELLD_IMAGE=ghcr.io/denoland/celld:0.6.2

FROM ${CELLD_IMAGE} AS celld

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json web/bun.lock ./web/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    bun install --frozen-lockfile && (cd web && bun install --frozen-lockfile)
COPY . .
# Type check and tests. The server installer skips them (RUN_CHECKS=0); they run in development.
ARG RUN_CHECKS=1
RUN if [ "$RUN_CHECKS" = 1 ]; then bun run verify && bun test; fi
RUN cd web && bun run build && test -f dist/index.html
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    rm -rf node_modules && bun install --frozen-lockfile --production

FROM ${BUN_IMAGE}
ARG BUILD_SHA=dev
# celld deploy bundles Worker code with esbuild; ship a native binary next to the CLI.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
COPY --from=build /app/node_modules /app/node_modules
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/web/dist ./web/dist
RUN ESB=$(find /app/node_modules -path '*/@esbuild/*/bin/esbuild' -type f | head -1); test -n "$ESB" && cp "$ESB" /usr/local/bin/esbuild && esbuild --version && celld --version
ENV NODE_ENV=production BUILD_SHA=${BUILD_SHA} PORT=8790 FLEETIQ_DATA=/data CELLD_ESBUILD=/usr/local/bin/esbuild WEB_DIST=/app/web/dist
VOLUME ["/data"]
EXPOSE 8790
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD curl -fsS http://127.0.0.1:8790/api/health >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "src/index.ts"]
