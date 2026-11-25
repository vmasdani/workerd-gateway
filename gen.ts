// Codegen: scans apps/*/worker.capnp and writes config.capnp for one workerd process
// that runs the gateway worker, one service per app, and (if any app has a cron.json)
// workerd's built-in cron scheduler. An app's optional hosts.json claims hostnames for it, and
// the hub's own hosts.json (per server, gitignored) maps more hostnames to apps.
//
//   bun gen.ts                                   writes config.capnp, listening on 127.0.0.1:8080
//   GATEWAY_ADDR=0.0.0.0:9000 bun gen.ts         other address
//   bun gen.ts --no-cron --out config.lb.capnp   for extra load-balanced instances (crons must run in one only)
//   GATEWAY_HOSTS=hosts.prod.json bun gen.ts     other hub-level hosts file (default hosts.json)
//
// Cap'n Proto has no globbing: every import must be a literal path, so the list of apps
// has to be written out by a script. This file is that script.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: {
		out: { type: "string", default: "config.capnp" },
		"no-cron": { type: "boolean", default: false },
	},
});

const APPS_DIR = "apps";
const CRON_DIR = "data/cron"; // Durable Object storage of the cron scheduler, relative to the working directory
const APP_DATA_DIR = "data/apps"; // per-app writable directories, relative to the working directory
const HUB_HOSTS = process.env.GATEWAY_HOSTS ?? "hosts.json"; // this server's host -> app map, optional
const ADDR = process.env.GATEWAY_ADDR ?? "127.0.0.1:8080";
const COMPAT_DATE = "2026-11-01";

// An app's folder name is its subdomain and its path prefix, so it must be a DNS label.
// Names cannot start with "_", which keeps /_gateway/* free for the gateway itself.
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// hosts.json patterns: "admin.example.com" (exact), "*.example.com" (any subdomain, not the apex),
// or "*" (every host no other rule picks, e.g. customers' custom domains). Lowercase, no port.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_PATTERN = new RegExp(`^(?:\\*|(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+)$`);

const apps: string[] = [];
const crons: Record<string, string[]> = {};
const disks: string[] = []; // apps whose worker.capnp uses the "disk:<name>" service
const hosts: Record<string, string> = {}; // hosts.json pattern -> app
let wantsNet = false; // some app uses the "net" service (public internet plus loopback)

for (const name of readdirSync(APPS_DIR).sort()) {
	// existsSync follows symlinks, so apps/<name> may be a symlink to another repo.
	if (!existsSync(`${APPS_DIR}/${name}/worker.capnp`)) continue;
	if (!NAME.test(name)) {
		console.warn(`skip ${APPS_DIR}/${name}: name must be lowercase letters, digits and "-" (a DNS label)`);
		continue;
	}
	// Every `embed "<path>"` must exist (paths are relative to the app's folder). An app whose build output
	// is missing is skipped, rather than making workerd refuse to start for every app.
	const capnp = await Bun.file(`${APPS_DIR}/${name}/worker.capnp`).text();
	const missing = [...capnp.matchAll(/embed\s+"([^"]+)"/g)]
		.map((m) => m[1]!)
		.filter((p) => !existsSync(`${APPS_DIR}/${name}/${p}`));
	if (missing.length > 0) {
		console.warn(`skip ${APPS_DIR}/${name}: missing ${missing.join(", ")} (build the app first)`);
		continue;
	}
	apps.push(name);

	// An app that mentions the service "disk:<name>" in its worker.capnp gets a writable directory,
	// data/apps/<name>, for its Durable Object storage (localDisk) and/or a file-writing binding.
	// Services must be declared in this file, not in the app's, so the app opts in by naming it.
	if (capnp.includes(`"disk:${name}"`)) disks.push(name);

	// An app that names the service "net" (usually `globalOutbound = "net"`) may reach loopback
	// addresses, e.g. Postgres on 127.0.0.1. workerd's default outbound only reaches public addresses.
	if (capnp.includes(`"net"`)) wantsNet = true;

	// Optional hosts.json: hostnames this app answers besides <name>.<anything>. See HOST_PATTERN.
	const hostsFile = Bun.file(`${APPS_DIR}/${name}/hosts.json`);
	if (await hostsFile.exists()) {
		const list: unknown = await hostsFile.json();
		if (!Array.isArray(list) || !list.every((h) => typeof h === "string" && HOST_PATTERN.test(h))) {
			throw new Error(
				`${APPS_DIR}/${name}/hosts.json: must be a JSON list of lowercase hostnames, "*.<domain>" or "*"`,
			);
		}
		for (const h of list) {
			if (hosts[h] && hosts[h] !== name) {
				throw new Error(`${APPS_DIR}/${name}/hosts.json: "${h}" is already claimed by ${hosts[h]}`);
			}
			hosts[h] = name;
		}
	}

	// Optional cron.json: a JSON list of cron expressions (Cloudflare's dialect, UTC) that call
	// the app's scheduled() handler. workerd validates the expressions when it loads the config.
	const cronFile = Bun.file(`${APPS_DIR}/${name}/cron.json`);
	if (await cronFile.exists()) {
		const list: unknown = await cronFile.json();
		if (!Array.isArray(list) || !list.every((c) => typeof c === "string")) {
			throw new Error(`${APPS_DIR}/${name}/cron.json: must be a JSON list of cron expressions`);
		}
		if (list.length > 0) crons[name] = list;
	}
}

// Hub-level hosts.json: this server's hostnames, kept out of the app repos. A JSON object of
// pattern -> app name, same patterns as an app's hosts.json. It wins over an app's own claim of the
// same pattern, because the server decides where its hostnames go.
const hubHostsFile = Bun.file(HUB_HOSTS);
if (await hubHostsFile.exists()) {
	const map: unknown = await hubHostsFile.json();
	if (typeof map !== "object" || map === null || Array.isArray(map)) {
		throw new Error(`${HUB_HOSTS}: must be a JSON object of hostname pattern -> app name`);
	}
	for (const [h, app] of Object.entries(map)) {
		if (!HOST_PATTERN.test(h)) {
			throw new Error(`${HUB_HOSTS}: "${h}" must be a lowercase hostname, "*.<domain>" or "*"`);
		}
		if (typeof app !== "string" || !apps.includes(app)) {
			console.warn(`${HUB_HOSTS}: skip "${h}": no app "${String(app)}" in ${APPS_DIR}/ (or it was skipped)`);
			continue;
		}
		if (hosts[h] && hosts[h] !== app) console.warn(`${HUB_HOSTS}: "${h}" moves from ${hosts[h]} to ${app}`);
		hosts[h] = app;
	}
}

const withCron = !args["no-cron"] && Object.keys(crons).length > 0;
if (withCron) mkdirSync(CRON_DIR, { recursive: true });
for (const n of disks) mkdirSync(`${APP_DATA_DIR}/${n}`, { recursive: true });

// Cap'n Proto identifiers cannot contain "-" or "_", so imports are numbered (App0, App1, ...).
const lines = (xs: string[]) => xs.join("\n");
const imports = lines(apps.map((n, i) => `using App${i} = import "${APPS_DIR}/${n}/worker.capnp";`));
const services = lines(apps.map((n, i) => `    (name = "app:${n}", worker = App${i}.worker),`));
const bindings = lines(apps.map((n) => `    (name = "${n}", service = "app:${n}"),`));
const diskServices = disks
	.map((n) => `\n    (name = "disk:${n}", disk = (path = "${APP_DATA_DIR}/${n}", writable = true)),`)
	.join("");
const netService = wantsNet ? `\n    (name = "net", network = (allow = ["public", "local"])),` : "";

const cronServices = `
    (name = "cron", worker = .cron),
    (name = "cron-disk", disk = (path = "${CRON_DIR}", writable = true)),`;

// workerd's bundled scheduler: one SQLite-backed Durable Object per schedule, woken by its alarm.
// It calls each app's scheduled() handler through a service binding named after the app.
// Runs at least once per occurrence, retrying a failed run up to 6 times with backoff.
const cronWorker = `
const cron :Workerd.Worker = (
  modules = [ (name = "cron", bundled = "/workerd/cron.js") ],
  compatibilityDate = "${COMPAT_DATE}",
  compatibilityFlags = ["service_binding_extra_handlers"],
  durableObjectNamespaces = [ (className = "Schedule", uniqueKey = "workerd-gateway-cron", enableSql = true) ],
  durableObjectStorage = (localDisk = "cron-disk"),
  bindings = [
    (name = "SCHEDULE", durableObjectNamespace = "Schedule"),
    (name = "CRONS", json = ${JSON.stringify(JSON.stringify(crons))}),
${lines(Object.keys(crons).map((n) => `    (name = "${n}", service = "app:${n}"),`))}
  ],
);
`;

const config = `# GENERATED by gen.ts from ${APPS_DIR}/*/worker.capnp. Do not edit: run \`bun gen.ts\`.
# Run with: workerd serve ${args.out} --experimental
using Workerd = import "/workerd/workerd.capnp";
${imports}

const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = .gateway),
${services}${diskServices}${netService}${withCron ? cronServices : ""}
  ],
  sockets = [ (name = "http", address = "${ADDR}", http = (), service = "gateway") ],
);

const gateway :Workerd.Worker = (
  modules = [ (name = "gateway", esModule = embed "dist/gateway.js") ],
  compatibilityDate = "${COMPAT_DATE}",
  bindings = [
    (name = "APPS", json = ${JSON.stringify(JSON.stringify(apps))}),
    (name = "HOSTS", json = ${JSON.stringify(JSON.stringify(hosts))}),
${bindings}
  ],
);
${withCron ? cronWorker : ""}`;

await Bun.write(args.out, config);
const hostNote = Object.keys(hosts).length > 0 ? `, hosts: ${Object.keys(hosts).length}` : "";
const cronNote = withCron ? `, crons: ${Object.keys(crons).join(", ")}` : args["no-cron"] ? ", crons off" : "";
console.log(`${args.out}: ${apps.length} app(s): ${apps.join(", ") || "(none)"} on ${ADDR}${hostNote}${cronNote}`);
