import type { Hono } from "hono";
import { ItemInput } from "./contract";
import * as repo from "./lib/repo";
// APP-OWNED.
export function itemRoutes(app: Hono) {
  app.get("/api/items", (c) => c.json(repo.listItems()));
  app.get("/api/items/:id", (c) => { const it = repo.getItem(c.req.param("id")); return it ? c.json(it) : c.json({ error: "not found" }, 404); });
  app.post("/api/items", async (c) => c.json(repo.createItem(ItemInput.parse(await c.req.json())), 201));
}
