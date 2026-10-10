import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
// One Drizzle schema drives both DO SQLite (edge) and bun:sqlite (local).
export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  note: text("note"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});
export type Item = typeof items.$inferSelect;

// workiq:schema
