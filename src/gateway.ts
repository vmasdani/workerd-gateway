// Gateway worker: sends each request to one app's service binding.
//
//   app-a.mydomain.com/hi       -> app "app-a", path /hi       (subdomain routing)
//   localhost:8080/app-a/hi     -> app "app-a", path /hi       (path routing, prefix stripped)
//   any host /_gateway/health   -> "ok"
//
// gen.ts generates the bindings: APPS (JSON list of app names) and one service binding per app.

interface Fetcher {
	fetch(req: Request): Promise<Response>;
}

type Env = { APPS: string[] } & Record<string, unknown>;

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === "/_gateway/health") return new Response("ok");

		// Check against APPS, not `name in env`, so a hostname can never select another binding
		// (APPS itself) or an Object.prototype property.
		const app = (name: string | undefined) => (name && env.APPS.includes(name) ? (env[name] as Fetcher) : undefined);

		// Subdomain: the first label of a dotted hostname. Request goes through unchanged.
		if (url.hostname.includes(".")) {
			const svc = app(url.hostname.split(".")[0]);
			if (svc) return svc.fetch(req);
		}

		// Path prefix: /<app>/rest -> /rest. The app gets the stripped prefix in X-Forwarded-Prefix
		// so it can build absolute links.
		const [, first, ...rest] = url.pathname.split("/");
		const svc = app(first);
		if (svc) {
			// /app-a -> /app-a/ so relative links in the app's pages resolve under the prefix.
			if (rest.length === 0) {
				url.pathname += "/";
				return Response.redirect(url.toString(), 308);
			}
			url.pathname = "/" + rest.join("/");
			const fwd = new Request(url.toString(), req);
			fwd.headers.set("X-Forwarded-Prefix", `/${first}`);
			return svc.fetch(fwd);
		}

		return new Response("not found", { status: 404 });
	},
};
