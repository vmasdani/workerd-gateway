// @cloudflare/actors example: per-user reminders. Build: `bun run build` (writes dist/worker.js).
//
// The gateway strips the app prefix, so http://localhost:8080/reminders/alice arrives here as
// /alice (and so does http://reminders.localhost:8080/alice).
//
//   GET /:user?in=10&text=tea   remind <user> in 10 seconds
//   GET /:user                  <user>'s pending reminders
//   GET /:user/cancel/:id       cancel one
//
// All GET so every route can be tried from a browser address bar. A real app would use POST and
// DELETE for the two that change state (browsers and crawlers prefetch GET links).
//
// Why the library: one user can have many reminders pending at once, each with its own time.
// A plain Durable Object has one alarm, so you would keep your own table of due times and
// re-arm the alarm for the earliest one after every change. `this.alarms` does that for you.
import { Actor, handler } from "@cloudflare/actors";

type Reminder = { text: string };

// `this.name` is the user. handler() below picks the instance with nameFromRequest().
export class Reminders extends Actor<Env> {
	static override async nameFromRequest(req: Request) {
		return new URL(req.url).pathname.match(/^\/([a-z0-9-]+)/)?.[1];
	}

	protected override async onRequest(req: Request) {
		const url = new URL(req.url);
		const [, , action, id] = url.pathname.split("/");
		if (req.method !== "GET") return new Response("method not allowed\n", { status: 405 });

		if (!action && url.searchParams.has("in")) {
			const seconds = Number(url.searchParams.get("in"));
			const text = url.searchParams.get("text") ?? "reminder";
			if (!Number.isFinite(seconds) || seconds < 0) return new Response("bad ?in\n", { status: 400 });
			// Each call adds one timer; earlier ones stay pending. "remind" is the method to call.
			const s = await this.alarms.schedule<Reminder>(seconds, "remind", { text });
			return Response.json({ id: s.id, at: new Date(s.time * 1000).toISOString(), text });
		}
		if (!action) {
			const pending = this.alarms.getSchedules<Reminder>().map((s) => ({
				id: s.id,
				at: new Date(s.time * 1000).toISOString(),
				text: s.payload.text,
			}));
			return Response.json({ user: this.name, pending });
		}
		if (action === "cancel" && id) {
			await this.alarms.cancelSchedule(id);
			return Response.json({ cancelled: id });
		}
		return new Response("not found\n", { status: 404 });
	}

	// Called by this.alarms when a reminder is due. The library catches a thrown error, logs it,
	// and drops the reminder: no retry (unlike a plain alarm() handler).
	async remind(payload: Reminder) {
		console.log(`reminders: ${new Date().toISOString()} [${this.name}] ${payload.text}`);
	}
}

// Bindings from worker.capnp. The library looks the namespace up by the class name.
type Env = { Reminders: DurableObjectNamespace<Reminders> };

// Worker entry point: finds the user's actor with nameFromRequest() and forwards the request.
// A path with no user ("/") makes nameFromRequest return undefined, and handler() answers 500.
export default handler(Reminders);
