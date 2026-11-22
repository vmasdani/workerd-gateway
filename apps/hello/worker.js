// Example app. Plain JS, so it needs no build step; a real app embeds its own build output.
export default {
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
};
