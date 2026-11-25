// Durable Object example, with Hono for routing. Build: `bun run build` (writes dist/worker.js).
//
// The gateway strips the app prefix, so http://localhost:8080/do-test/run-task/user1 arrives
// here as /run-task/user1 (and so does http://do-test.localhost:8080/run-task/user1).
//
//   GET /run-task/:user   start <user>'s run, or report it if one is already running
//   GET /status/:user     where <user>'s run is
//   GET /result/:user     the result file, once the run is done
//
// Each user gets one `Run` Durable Object (idFromName(user)) with its own SQLite file. A run logs
// "task1 running" ... "task5 running", 10 seconds apart, then 10 seconds later writes
// data/apps/do-test/results/<user>.txt. Every step is one alarm, and progress is saved before the
// next alarm is set, so a workerd restart mid-run resumes at the step it was on.
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

// Bindings from worker.capnp.
type Env = {
	RUNS: DurableObjectNamespace<Run>; // the Run Durable Objects
	FILES: Fetcher; // data/apps/do-test on disk: GET reads a file, PUT writes one
};

type RunState = { user: string; task: number; status: "running" | "done" };

const TASKS = 5;
const PAUSE_MS = 10_000;

const log = (user: string, msg: string) => console.log(`do-test: ${new Date().toISOString()} [${user}] ${msg}`);

// ---------------------------------------------------------------------------------------------
// The Durable Object: one instance per user, single-threaded, with its own SQLite database.
// ---------------------------------------------------------------------------------------------

export class Run extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// One row: this object's run. Runs on every wake-up; IF NOT EXISTS makes it a no-op after the first.
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS run (id INTEGER PRIMARY KEY CHECK (id = 1), user TEXT, task INTEGER, status TEXT)",
		);
	}

	// RPC method: the router calls it as `stub.state()`.
	state(): RunState | null {
		return this.ctx.storage.sql.exec<RunState>("SELECT user, task, status FROM run").toArray()[0] ?? null;
	}

	// RPC method: save the starting state, then wake up right away to run task 1.
	async start(user: string) {
		const run = this.state();
		if (run?.status === "running") return { ...run, note: "already running" };
		this.ctx.storage.sql.exec("INSERT OR REPLACE INTO run VALUES (1, ?, 0, 'running')", user);
		await this.ctx.storage.setAlarm(Date.now());
		log(user, "run started");
		return { user, task: 0, status: "running" };
	}

	// Called by workerd when the alarm fires. One step per wake-up; between steps the object
	// can be evicted from memory. A thrown error makes workerd retry the alarm.
	override async alarm() {
		const run = this.state();
		if (run?.status !== "running") return;

		// Tasks 1-5: log, save progress, sleep 10 s by setting the next alarm.
		if (run.task < TASKS) {
			const task = run.task + 1;
			log(run.user, `task${task} running`);
			this.ctx.storage.sql.exec("UPDATE run SET task = ?", task);
			await this.ctx.storage.setAlarm(Date.now() + PAUSE_MS);
			return;
		}

		// 10 s after task 5: write the result file and finish.
		const body = Array.from({ length: TASKS }, (_, i) => `${run.user} task${i + 1} done\n`).join("");
		const res = await this.env.FILES.fetch(`http://files/results/${run.user}.txt`, { method: "PUT", body });
		if (!res.ok) throw new Error(`writing results/${run.user}.txt failed: ${res.status}`);
		this.ctx.storage.sql.exec("UPDATE run SET status = 'done'");
		log(run.user, `done, wrote data/apps/do-test/results/${run.user}.txt`);
	}
}

// ---------------------------------------------------------------------------------------------
// The router: stateless, finds the user's Durable Object and calls it.
// ---------------------------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// `:user` only matches a-z, 0-9 and "-", which also keeps the result file name safe.
// Anything else is a 404. Unauthenticated on purpose: a real app takes the user from the session.
const USER = ":user{[a-z0-9-]+}";

// Same name, same object, every time: idFromName("user1") always reaches user1's Run.
const runOf = (env: Env, user: string) => env.RUNS.get(env.RUNS.idFromName(user));

app.get("/", (c) => c.text("GET /run-task/:user, /status/:user, /result/:user\n"));

app.get(`/run-task/${USER}`, async (c) => {
	const user = c.req.param("user");
	return c.json(await runOf(c.env, user).start(user));
});

app.get(`/status/${USER}`, async (c) => {
	const user = c.req.param("user");
	return c.json((await runOf(c.env, user).state()) ?? { user, status: "never run" });
});

app.get(`/result/${USER}`, async (c) => {
	const user = c.req.param("user");
	const res = await c.env.FILES.fetch(`http://files/results/${user}.txt`);
	if (!res.ok) return c.text(`no result for ${user} yet\n`, 404);
	return c.text(await res.text());
});

export default app;
