// App template: Hono for routing, Drizzle for queries, SQLite in a Durable Object for storage.
// Start a new app from it: see "Starting a new app" in the README. Build: `bun run build` (writes dist/worker.js).
//
// The gateway strips the app prefix, so http://localhost:8080/<app>/notes arrives here as /notes.
//
//   GET    /notes       list notes, newest first
//   POST   /notes       {"text": "..."} adds a note
//   DELETE /notes/:id   removes a note
//
// All data lives in one `Db` Durable Object (idFromName("main")): one SQLite file, one thread,
// so no write conflicts. Safe with a single workerd instance only. For several instances, keep the
// schema and swap the driver for libSQL (`drizzle-orm/libsql/web`), see the README's Database section.
import { DurableObject } from "cloudflare:workers";
import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { Hono } from "hono";
import { z } from "zod";
import migrations from "../drizzle/migrations";
import * as schema from "./db/schema";
import { notes } from "./db/schema";

// Bindings from worker.capnp.
type Env = {
	DB: DurableObjectNamespace<Db>;
};

// ---------------------------------------------------------------------------------------------
// The Durable Object: owns the database. Every query is an RPC method here.
// ---------------------------------------------------------------------------------------------

export class Db extends DurableObject<Env> {
	private db: DrizzleSqliteDODatabase<typeof schema>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, { schema });
		// Apply pending migrations before any RPC call runs. A no-op once the schema is current.
		ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	listNotes() {
		return this.db.select().from(notes).orderBy(desc(notes.id)).all();
	}

	addNote(text: string) {
		return this.db.insert(notes).values({ text }).returning().get();
	}

	// Returns false if there was no such note.
	deleteNote(id: number) {
		return this.db.delete(notes).where(eq(notes.id, id)).returning({ id: notes.id }).all().length > 0;
	}
}

// ---------------------------------------------------------------------------------------------
// The router: stateless, validates input, calls the Durable Object.
// ---------------------------------------------------------------------------------------------

const db = (env: Env) => env.DB.get(env.DB.idFromName("main"));

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("GET /notes, POST /notes {text}, DELETE /notes/:id\n"));

app.get("/notes", async (c) => c.json(await db(c.env).listNotes()));

app.post("/notes", zValidator("json", z.object({ text: z.string().trim().min(1).max(1000) })), async (c) => {
	const { text } = c.req.valid("json");
	return c.json(await db(c.env).addNote(text), 201);
});

app.delete("/notes/:id", zValidator("param", z.object({ id: z.coerce.number().int().positive() })), async (c) => {
	const { id } = c.req.valid("param");
	return (await db(c.env).deleteNote(id)) ? c.body(null, 204) : c.json({ error: "not found" }, 404);
});

export default app;
