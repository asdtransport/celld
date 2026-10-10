import { z } from "zod";
// Zod at every mutation boundary.
const appName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "1–63 lowercase letters, digits or inner hyphens (same rule as a Worker name)");
export const AppCreate = z.object({
  name: appName,
  description: z.string().max(200).optional(),
  managed: z.boolean().default(true),
  desiredNodes: z.number().int().min(0).max(9).default(2),
  nodeImage: z.string().max(200).optional(),
  healthPath: z.string().startsWith("/").max(200).default("/"),
});
export const AppPatch = z.object({
  description: z.string().max(200).optional(),
  nodeImage: z.string().max(200).optional(),
  healthPath: z.string().startsWith("/").max(200).optional(),
});
export const Scale = z.object({ nodes: z.number().int().min(0).max(9) });
export const Rollback = z.object({ version: z.string().regex(/^[0-9a-f]{16}$/) });
export const RouteUpsert = z.object({
  host: z.string().max(253).regex(/^(\*|[a-z0-9*]([a-z0-9-.]*[a-z0-9])?)$/i, "a hostname such as app.example.com, or * for the default route"),
  app: appName,
});
export const KvPut = z.object({ key: z.string().min(1).max(512), value: z.string().max(1_000_000) });
export const D1Query = z.object({ sql: z.string().min(1).max(20_000) });
export const QueueAction = z.enum(["pause", "resume", "purge", "redrive"]);
export const TunnelCreate = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-_]{0,40}$/i),
  localHost: z.string().max(100).default("lb"),
  localPort: z.number().int().min(1).max(65535).default(8080),
  remotePort: z.number().int().min(1).max(65535),
});
export const ContainerAction = z.enum(["start", "stop", "restart"]);
