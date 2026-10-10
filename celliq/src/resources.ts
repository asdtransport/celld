import type { Hono } from "hono";
import { getDb } from "./db/runtime";
import { items } from "./db/schema";
import { itemRoutes } from "./routes";
// workiq:imports

// APP-OWNED SEAM. `create-workiq resource <Name>` wires new resources here.
export const dbPing = () => { getDb().select().from(items).limit(1).all(); };
export const registerRoutes = (app: Hono) => {
  itemRoutes(app);
  // workiq:routes
};
