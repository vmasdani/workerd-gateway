// Example app. Plain JS, so it needs no build step; a real app embeds its own build output.
const app = {
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/hi") return new Response("hello world!");
		// Echo what the app sees, to show what the gateway forwards.
		if (url.pathname === "/whoami") {
			return Response.json({
				url: req.url,
				host: req.headers.get("Host"),
				prefix: req.headers.get("X-Forwarded-Prefix"),
			});
		}
		return new Response("not found", { status: 404 });
	},

	// Called by workerd's cron scheduler for each expression in cron.json (hourly here).
	// Same handler as Cloudflare Workers cron triggers. A thrown error counts as a failed run and is retried.
	//
	// It runs GET /hi by calling this app's own fetch handler in-process: the same response as
	// http://hello.localhost:8080/hi, without a network round trip. (Fetching that URL from inside
	// workerd would fail anyway: default outbound access only reaches public addresses.)
	async scheduled(controller, env, ctx) {
		const res = await app.fetch(new Request("http://hello.localhost/hi"), env, ctx);
		const body = await res.text();
		console.log(`hello: cron "${controller.cron}" GET /hi -> ${res.status} ${body}`);
		if (!res.ok) throw new Error(`GET /hi returned ${res.status}`);
	},
};

export default app;
