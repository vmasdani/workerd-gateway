// Tables. Change this file, then run `bun run db:generate` to write the migration. Never edit the
// database by hand or with raw SQL: the migration files are the only way the schema changes.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notes = sqliteTable("notes", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	text: text("text").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
