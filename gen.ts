// Codegen: scans apps/*/worker.capnp and writes config.capnp for one workerd process
// that runs the gateway worker, one service per app, and (if any app has a cron.json)
// workerd's built-in cron scheduler.
//
//   bun gen.ts                                   writes config.capnp, listening on 127.0.0.1:8080
//   GATEWAY_ADDR=0.0.0.0:9000 bun gen.ts         other address
//   bun gen.ts --no-cron --out config.lb.capnp   for extra load-balanced instances (crons must run in one only)
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
const ADDR = process.env.GATEWAY_ADDR ?? "127.0.0.1:8080";
const COMPAT_DATE = "2026-11-01";

// An app's folder name is its subdomain and its path prefix, so it must be a DNS label.
// Names cannot start with "_", which keeps /_gateway/* free for the gateway itself.
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const apps: string[] = [];
const crons: Record<string, string[]> = {};
const disks: string[] = []; // apps whose worker.capnp uses the "disk:<name>" service

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
${services}${diskServices}${withCron ? cronServices : ""}
  ],
  sockets = [ (name = "http", address = "${ADDR}", http = (), service = "gateway") ],
);

const gateway :Workerd.Worker = (
  modules = [ (name = "gateway", esModule = embed "dist/gateway.js") ],
  compatibilityDate = "${COMPAT_DATE}",
  bindings = [
    (name = "APPS", json = ${JSON.stringify(JSON.stringify(apps))}),
${bindings}
  ],
);
${withCron ? cronWorker : ""}`;

await Bun.write(args.out, config);
const cronNote = withCron ? `, crons: ${Object.keys(crons).join(", ")}` : args["no-cron"] ? ", crons off" : "";
console.log(`${args.out}: ${apps.length} app(s): ${apps.join(", ") || "(none)"} on ${ADDR}${cronNote}`);
