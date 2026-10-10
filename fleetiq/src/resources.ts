import type { Hono } from "hono";
import { appRoutes } from "./api/apps";
import { automationRoutes, hookRoutes } from "./api/automation";
import { mcpRoutes } from "./api/catalog";
import { moverRoutes } from "./api/mover";
import { dataRoutes } from "./api/data";
import { platformRoutes } from "./api/platform";
import { authMiddleware } from "./auth";
import { getDb } from "./db/runtime";
import { apps } from "./db/schema";

// APP-OWNED SEAM.
export const dbPing = () => { getDb().select().from(apps).limit(1).all(); };
export const registerRoutes = (app: Hono) => {
  app.use("/api/*", authMiddleware);
  appRoutes(app);
  dataRoutes(app);
  platformRoutes(app);
  automationRoutes(app);
  moverRoutes(app);
  hookRoutes(app);
  mcpRoutes(app);
};
