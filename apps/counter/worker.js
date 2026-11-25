// Counter Durable Object: scaffolding. Plain JS, no build step.
//
// The gateway strips the app prefix, so http://localhost:8080/counter/start/foo arrives here as
// /start/foo (and so does http://counter.localhost:8080/start/foo).
//
//   GET /start/:name   start <name>'s counter: its alarm then fires every 10 seconds
//
// Binding (worker.capnp): env.COUNTERS, the Counter namespace. Storage: data/apps/counter/.
import { DurableObject } from "cloudflare:workers";

const PAUSE_MS = 10_000;

export class Counter extends DurableObject {
	// RPC method: the fetch handler calls it as `await stub.start(name)`.
	async start(name) {
		// Already ticking: an alarm is set. Don't start a second chain.
		if ((await this.ctx.storage.getAlarm()) !== null) return { name, note: "already running" };
		await this.ctx.storage.put("name", name);
		await this.ctx.storage.setAlarm(Date.now());

		return { name, note: "started" };
	}

	// Called by workerd when the alarm fires. A thrown error makes workerd retry the alarm.
	async alarm() {
		const name = await this.ctx.storage.get("name");

		// write counter code here
		await this.ctx.storage.put("count", (await this.ctx.storage.get('count') ?? 0) +1);

		const count = (await this.ctx.storage.get('count') ?? 0);
		console.log(`counter: ${new Date().toISOString()} [${name}] alarm fired. Now: ${count}`); 

		// Next tick in 10 seconds.
		await this.ctx.storage.setAlarm(Date.now() + PAUSE_MS);
	}
}

export default {
	async fetch(req, env) {
		const m = new URL(req.url).pathname.match(/^\/start\/([a-z0-9-]+)$/);
		if (!m) return new Response("GET /start/:name\n", { status: 404 });
		const name = m[1];

		// Same name, same object, every time.
		const stub = env.COUNTERS.get(env.COUNTERS.idFromName(name));
		return Response.json(await stub.start(name));
	},
};
