// Gateway worker: sends each request to one app's service binding.
//
//   admin.example.com/hi        -> app claiming "admin.example.com" in its hosts.json (exact host)
//   shop1.example.com/hi        -> app claiming "*.example.com" (longest suffix wins)
//   app-a.mydomain.com/hi       -> app "app-a", path /hi       (subdomain routing)
//   localhost:8080/app-a/hi     -> app "app-a", path /hi       (path routing, prefix stripped)
//   any other host              -> app claiming "*", if any (e.g. customers' custom domains)
//   any host /_gateway/health   -> "ok"
//
// gen.ts generates the bindings: APPS (JSON list of app names), HOSTS (JSON map of hosts.json
// pattern -> app name) and one service binding per app.

interface Fetcher {
	fetch(req: Request): Promise<Response>;
}

type Env = { APPS: string[]; HOSTS?: Record<string, string> } & Record<string, unknown>;

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === "/_gateway/health") return new Response("ok");

		// Check against APPS, not `name in env`, so a hostname can never select another binding
		// (APPS itself) or an Object.prototype property.
		const app = (name: string | undefined) => (name && env.APPS.includes(name) ? (env[name] as Fetcher) : undefined);
		// Object.hasOwn: a host like "constructor" must not read Object.prototype.
		const hosts = env.HOSTS ?? {};
		const claimed = (pattern: string) => (Object.hasOwn(hosts, pattern) ? app(hosts[pattern]) : undefined);

		// URL already lowercases the hostname; drop a trailing dot ("example.com.").
		const host = url.hostname.replace(/\.$/, "");

		// hosts.json: exact host first, then "*.<suffix>" from the longest suffix to the shortest.
		// The request goes through unchanged, like subdomain routing.
		const exact = claimed(host);
		if (exact) return exact.fetch(req);
		const labels = host.split(".");
		for (let i = 1; i < labels.length - 1; i++) {
			const svc = claimed(`*.${labels.slice(i).join(".")}`);
			if (svc) return svc.fetch(req);
		}

		// Subdomain: the first label of a dotted hostname. Request goes through unchanged.
		if (host.includes(".")) {
			const svc = app(labels[0]);
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

		// Catch-all: hosts.json "*". Last, so subdomain and path routing keep working beside it.
		const fallback = claimed("*");
		if (fallback) return fallback.fetch(req);

		return new Response("not found", { status: 404 });
	},
};
