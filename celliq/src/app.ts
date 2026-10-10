import { makeApi } from "./factory";
import { dbPing, registerRoutes } from "./resources";
// BASE-OWNED. Composes the vendored factory with this app's resources seam.
export const buildApp = (opts: { buildSha?: string; allowedOrigins?: string[]; maxBodyBytes?: number; rateLimit?: { max: number; windowMs: number } } = {}) =>
  makeApi({ ...opts, dbPing, routes: registerRoutes });
