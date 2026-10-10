import { eq } from "drizzle-orm";
import { getDb } from "../db/runtime";
import { items, type Item } from "../db/schema";
// Synchronous repo. Because DO SQLite is synchronous (like bun:sqlite), these
// exact functions run unchanged at the edge — no async rewrite, one code path.
export const listItems = (): Item[] => getDb().select().from(items).all();
export const getItem = (id: string): Item | undefined =>
  getDb().select().from(items).where(eq(items.id, id)).get();
export const createItem = (input: { name: string; note?: string }): Item => {
  const row: Item = { id: crypto.randomUUID(), name: input.name, note: input.note ?? null, createdAt: Math.floor(Date.now() / 1000) };
  getDb().insert(items).values(row).run();
  return row;
};
export const updateItem = (id: string, input: { name?: string; note?: string }): Item | undefined => {
  const existing = getItem(id);
  if (!existing) return undefined;
  getDb().update(items).set(input).where(eq(items.id, id)).run();
  return getItem(id);
};
export const deleteItem = (id: string): { id: string; deleted: boolean } => {
  getDb().delete(items).where(eq(items.id, id)).run();
  return { id, deleted: true };
};
