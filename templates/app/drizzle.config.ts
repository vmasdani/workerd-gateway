// drizzle-kit config. `bun run db:generate` diffs src/db/schema.ts against drizzle/ and writes a new
// migration there (SQL file + migrations.js). Commit drizzle/: the Durable Object applies it on wake-up.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	driver: "durable-sqlite",
	schema: "./src/db/schema.ts",
	out: "./drizzle",
});
