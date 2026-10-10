import { config } from "../config";
import { unixJson } from "./http";

// The load balancer's Caddy admin API listens on a unix socket shared only with FleetIQ, so Workers on
// the fleet network cannot reconfigure it. FleetIQ renders the whole config from its routes table.
export interface RouteTarget { host: string; app: string; upstreams: string[]; healthPath: string }

export function renderLbConfig(targets: RouteTarget[]) {
  const sorted = [...targets].sort((a, b) => (a.host === "*" ? 1 : b.host === "*" ? -1 : a.host.localeCompare(b.host)));
  return {
    admin: { listen: `unix/${config.lbAdminSock}` },
    apps: {
      http: {
        servers: {
          lb: {
            listen: [config.lbListen],
            automatic_https: { disable: true },
            routes: sorted.map((t) => ({
              ...(t.host === "*" ? {} : { match: [{ host: [t.host] }] }),
              handle: t.upstreams.length
                ? [{
                    handler: "reverse_proxy",
                    upstreams: t.upstreams.map((dial) => ({ dial })),
                    load_balancing: { selection_policy: { policy: "round_robin" }, try_duration: "5s" },
                    health_checks: {
                      active: { uri: t.healthPath, interval: "5s", timeout: "3s" },
                      passive: { fail_duration: "10s", max_fails: 2 },
                    },
                  }]
                : [{ handler: "static_response", status_code: 503, body: `No running nodes for ${t.app}` }],
              terminal: true,
            })).concat([{ handle: [{ handler: "static_response", status_code: 404, body: "No route for this host" }], terminal: true } as any]),
          },
        },
      },
    },
  };
}

export const lbConfig = () => unixJson(config.lbAdminSock, "/config/");
export const lbUpstreams = () => unixJson<{ address: string; num_requests: number; fails: number }[]>(config.lbAdminSock, "/reverse_proxy/upstreams");
export async function lbLoad(cfg: unknown) {
  await unixJson(config.lbAdminSock, "/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) }, 15_000);
}
