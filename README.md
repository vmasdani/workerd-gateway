# workerd-gateway

![workerd-gateway overview: apps/<name>/ folders go through bun gen.ts into config.capnp; requests pass nginx or Caddy to one workerd process that routes to isolated Worker apps by hostname or path; apps hand background work to Durable Objects with per-object state, persistent storage and alarms; an optional built-in cron scheduler triggers apps](docs/overview.png)

One [workerd](https://github.com/cloudflare/workerd) process, run as a system-wide systemd service, hosts many apps.
A small gateway worker in front of them picks the app for each request:

| Request | App | Path the app sees |
|---|---|---|
| `http://localhost:8080/app-a/hello?q=abcd` | `app-a` | `/hello?q=abcd` (prefix stripped) |
| `https://app-a.mydomain.com/hello?q=abcd` | `app-a` | `/hello?q=abcd` |
| `http://app-a.localhost:8080/hello` | `app-a` | `/hello` (`*.localhost` resolves to 127.0.0.1, no DNS needed) |
| `https://admin.example.com/hello`, `https://shop1.example.com/hello` | the app whose `hosts.json` lists `admin.example.com` or `*.example.com` | `/hello` |
| any other host (a customer's own domain) | the app whose `hosts.json` lists `*`, if any | unchanged |
| any host, `/_gateway/health` | gateway | answers `ok` (for load balancer health checks) |

Apps are ordinary Workers: `export default { fetch(req, env) }`. They don't know about the gateway. The same code
deploys to Cloudflare Workers unchanged.

## Why: the PHP-FPM model for Workers

The setup copies how PHP sites are usually hosted. There's one long-running runtime on the server, a web server routes
each virtual host to it, and adding a site means dropping a folder in place, not setting up a new service.

| PHP hosting | This repo |
|---|---|
| `/var/www/<site>/` | `apps/<name>/` |
| Apache or nginx virtual host per site | gateway routing by subdomain or path, with no per-app config |
| PHP-FPM, one system service for every site | one `workerd-gateway` systemd service for every app |
| FPM pool size (`pm.max_children`) | number of `workerd-gateway@<port>` instances |
| `php.ini` / pool `env[...]` | per-app bindings in `worker.capnp` |

Benefits:

- **Easier deployment.** A new app is a folder with a `worker.capnp` and its built `worker.js`, followed by
  `bun gen.ts` and a restart. There's no new systemd unit, port or reverse-proxy entry, and the subdomain works
  straight away under a wildcard certificate.
- **One service to run.** You get one unit and one log stream (`journalctl -u workerd-gateway`), and you upgrade
  workerd once for every app, instead of one Node or Bun process per app, each with its own port and its own pm2 or
  systemd entry.
- **Cheap per app.** Each app is a V8 isolate inside the shared process, not a separate runtime process, so an idle
  app costs a few MB instead of a whole runtime.
- **Separated apps.** Each app has its own globals and its own bindings. One app can't read another's secrets or
  module state.
- **Portable.** Apps use only the standard Workers API, so the same code deploys to Cloudflare Workers when an app
  outgrows the server.

The model differs from PHP-FPM in three ways:

- **Deploying needs a restart.** PHP reads files on each request, so copying a file is the whole deploy. workerd loads
  code at startup, so a deploy is `bun gen.ts` plus a restart. With one instance, the restart briefly drops
  connections. With several instances behind a load balancer, restart them one at a time.
- **State persists between requests.** FPM resets state after every request. Here an isolate lives as long as the
  process, so module-scope variables carry over between requests. That's useful for caches, but it's also an easy way
  to leak data between users by accident. State that must survive a restart belongs in a Durable Object or a database
  (see [Background tasks and state](#background-tasks-and-state-durable-objects)).
- **Apps share a thread.** FPM gives each request its own worker process. Here every app in an instance shares that
  instance's single JavaScript thread, so one app stuck in a long synchronous loop stalls every other app on the same
  instance. Running several instances limits the damage. Apps that do heavy CPU work belong on their own instance or
  outside the hub. Long-running work that mostly waits (on LLM calls, APIs, other services) runs in Durable Objects,
  not in a separate service.

## Try it out

The repo ships four example apps: `apps/hello` and `apps/hi` (plain JS, no build), `apps/do-test` (a Durable
Object background task with Hono, which builds itself), and `apps/reminders` (several timers per object with
`@cloudflare/actors`, also built):

```bash
bun install
(cd apps/do-test && bun install && bun run build)   # optional: without it, gen.ts skips do-test
(cd apps/reminders && bun install && bun run build) # optional, same
bun run dev    # builds the gateway, runs bun gen.ts, starts workerd
```

| URL | Returns |
|---|---|
| http://hello.localhost:8080/hi | `hello world!` |
| http://hi.localhost:8080/hi | `hi world!` |
| http://localhost:8080/hello/hi | `hello world!` (path routing) |
| http://localhost:8080/hi/hi | `hi world!` (path routing) |
| http://localhost:8080/do-test/run-task/user1 | starts a 50-second background task; watch the workerd log |
| http://localhost:8080/reminders/alice?in=10&text=tea | schedules a reminder that logs in 10 seconds; http://localhost:8080/reminders/alice lists pending ones |

`*.localhost` resolves to 127.0.0.1 in browsers and curl, so subdomains work with no DNS or `/etc/hosts` entry. To
start a new app, copy `templates/app` (see [Starting a new app](#starting-a-new-app-hono--drizzle)). `gen.ts` skips an
app whose `embed` files don't exist yet, with a warning to build it first.

`bun run dev` passes `--experimental` for you. If you run workerd by hand without it, it refuses to start, because
the built-in cron scheduler uses experimental features:

```
Bundled modules are an experimental feature which may change or go away in the future. You must run workerd with `--experimental` to use this feature.
service cron: The compatibility flag service_binding_extra_handlers is experimental and may break or be removed in a future version of workerd. To use this flag, you must pass --experimental on the command line.
```

Fix it by adding the flag (`workerd serve config.capnp --experimental`), or regenerate without the scheduler
(`bun gen.ts --no-cron`) if you don't need crons.

## Codegen: the core of this repo

workerd is configured with a Cap'n Proto file, and Cap'n Proto cannot glob or list a directory: every `import` and
`embed` must be a literal path. So the list of apps cannot live in a hand-written config. `gen.ts` writes it.

```bash
bun gen.ts                                    # writes config.capnp, listening on 127.0.0.1:8080
GATEWAY_ADDR=0.0.0.0:9000 bun gen.ts          # other listen address
bun gen.ts --no-cron --out config.lb.capnp    # extra load-balanced instances (see "Using all CPU cores")
```

What it does:

1. Lists `apps/*/` and keeps every folder that contains a `worker.capnp`. Symlinked folders count.
2. Checks the folder name is a DNS label (`a-z`, `0-9`, `-`, max 63 characters, no leading or trailing `-`). The name is the
   app's subdomain and path prefix, so anything else is skipped with a warning. Names can't start with `_`, which keeps
   `/_gateway/*` free.
3. Checks that every file the app's `worker.capnp` embeds exists, and skips the app with a warning if one doesn't
   (its build hasn't run yet).
4. Writes `config.capnp` with:
   - one `using AppN = import "apps/<name>/worker.capnp";` per app,
   - one service `app:<name>` per app, using that file's `worker` const,
   - the gateway worker with a service binding per app (`env["<name>"]`), an `APPS` JSON list of the names, and a
     `HOSTS` JSON map from each `hosts.json` pattern (the apps' and the hub's) to its app,
   - one socket, `http`, pointing at the gateway,
   - a writable disk service `disk:<name>` at `data/apps/<name>` for each app whose `worker.capnp` names it (for
     Durable Object storage and files),
   - a network service `net` (public addresses plus loopback) if any app's `worker.capnp` names it,
   - if any app has a `cron.json` (and `--no-cron` isn't set): workerd's built-in cron scheduler, a `cron` worker
     running the bundled `/workerd/cron.js` with its state in `data/cron` (see [Scheduled jobs](#scheduled-jobs-cron)).

For two apps without crons, the output looks like this:

```capnp
# GENERATED by gen.ts from apps/*/worker.capnp. Do not edit: run `bun gen.ts`.
using Workerd = import "/workerd/workerd.capnp";
using App0 = import "apps/app-a/worker.capnp";
using App1 = import "apps/app-b/worker.capnp";

const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = .gateway),
    (name = "app:app-a", worker = App0.worker),
    (name = "app:app-b", worker = App1.worker),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:8080", http = (), service = "gateway") ],
);

const gateway :Workerd.Worker = (
  modules = [ (name = "gateway", esModule = embed "dist/gateway.js") ],
  compatibilityDate = "2026-11-01",
  bindings = [
    (name = "APPS", json = "[\"app-a\",\"app-b\"]"),
    (name = "HOSTS", json = "{}"),
    (name = "app-a", service = "app:app-a"),
    (name = "app-b", service = "app:app-b"),
  ],
);
```

`config.capnp` is gitignored. Run `bun gen.ts` again after adding or removing an app, then restart workerd. Imports
are numbered `App0`, `App1` and so on because Cap'n Proto identifiers can't contain `-` or `_`.

The gateway (`src/gateway.ts`) only routes to names in `APPS`, so a hostname like `constructor.mydomain.com` or a path
like `/APPS/` can't select something that isn't an app.

### Routing order

The gateway tries these in order and uses the first that matches:

1. `/_gateway/health` on any host answers `ok`.
2. An exact host from some app's `hosts.json`.
3. A `*.<suffix>` pattern from `hosts.json`, longest suffix first. `*.example.com` matches `a.example.com` and
   `a.b.example.com`, not `example.com` itself.
4. Subdomain routing: the first label of the host is an app name.
5. Path routing: the first path segment is an app name (prefix stripped).
6. The app whose `hosts.json` lists `*`.
7. `404 not found`.

Hosts claimed in `hosts.json` never reach subdomain or path routing, so an app that owns its hosts sees every path
unchanged. A host that only the `*` app catches still goes through steps 4 and 5 first: on a customer domain,
`hello.customer.com` or `customer.com/hello/` reaches the app `hello`. Avoid app names that clash with the catch-all
app's first path segments (`api`, `assets` and the like).

### Hub-level hosts.json (this server's hostnames)

Hostnames usually belong to the server, not to the app's repo: the same app can run on several servers under
different domains. Put them in `hosts.json` at the hub root, which is gitignored (copy `hosts.example.json`):

```json
{
  "admin.example.com": "usdtpg",
  "*.shops.example.com": "usdtpg",
  "*": "usdtpg"
}
```

- Same patterns as an app's `hosts.json`, mapped to an app name.
- It wins over an app's own `hosts.json` for the same pattern (`gen.ts` prints a warning when it moves one).
- An entry for an app that isn't in `apps/` (or was skipped) is ignored with a warning.
- `GATEWAY_HOSTS=hosts.prod.json bun gen.ts` reads another file.
- Like the app files, it takes effect after `bun gen.ts` and a restart.

## App folder format

Each app folder needs exactly one thing: a `worker.capnp` that defines a const named **`worker`** of type
`Workerd.Worker`. Optionally, a `cron.json` schedules the app's `scheduled()` handler, and a `hosts.json` claims
hostnames for it. Everything else is up to the app.

```capnp
# apps/<name>/worker.capnp
using Workerd = import "/workerd/workerd.capnp";

const worker :Workerd.Worker = (
  modules = [ (name = "worker", esModule = embed "dist/worker.js") ],
  compatibilityDate = "2026-11-01",
  bindings = [
    (name = "API_KEY", fromEnvironment = "APP_A_API_KEY"),
  ],
);
```

Rules:

- `embed` paths are relative to the `worker.capnp` that contains them, not to this repo.
- The embedded module must be a finished ES module. The gateway doesn't build apps: each app builds itself (for
  example `bun build src/index.ts --outfile dist/worker.js --target browser --format esm`), and `worker.capnp` points
  at the output.
- `compatibilityDate` can't be later than the installed workerd version (`bunx workerd --version`).
- The app owns its bindings (secrets, compatibility flags). The gateway and other apps can't see them.
- `cron.json`, if present, is a JSON list of cron expressions, the same as `triggers.crons` in a Wrangler config:
  `["0 3 * * *", "*/15 * * * *"]`.
- `hosts.json`, if present, is a JSON list of lowercase hostnames the app answers besides `<name>.<anything>`:
  exact hosts (`admin.example.com`), wildcards (`*.example.com`), or `"*"` for every host no other rule picks (custom
  domains). A pattern can belong to one app only: `gen.ts` stops with an error if two apps claim it. See
  [Routing order](#routing-order).
- An app that names the service `"net"` (normally `globalOutbound = "net"`) can reach loopback addresses as well as
  public ones, e.g. PostgreSQL on `127.0.0.1`. workerd's default outbound only reaches public addresses. `gen.ts`
  declares `(name = "net", network = (allow = ["public", "local"], tlsOptions = (trustBrowserCas = true)))` once any app uses
  it. `tlsOptions` is required: without it, HTTPS through `net` fails with "this client has no TLS configuration".
- An app that names the service `"disk:<name>"` in its `worker.capnp` gets a writable directory,
  `data/apps/<name>`, declared by `gen.ts`. Use it as `durableObjectStorage = (localDisk = "disk:<name>")` for
  Durable Objects, or bind it (`(name = "FILES", service = "disk:<name>")`) to read and `PUT` files. See
  `apps/do-test`. Like cron state, it must belong to one instance only.

### Starting a new app: Hono + Drizzle

New apps start from `templates/app`, so that every app has the same structure: [Hono](https://hono.dev) for routing,
[zod](https://zod.dev) through `@hono/zod-validator` for request input, and [Drizzle](https://orm.drizzle.team) for
queries. Don't hand-write routers or SQL strings. With the schema in TypeScript, `bun run typecheck` catches a wrong
column name or type at build time, which a raw `sql.exec("...")` string would only show when it runs. The template
stores data in one SQLite-backed Durable Object, so it needs no extra service.

```bash
cp -r templates/app apps/<name>
sed -i 's/__APP__/<name>/g' apps/<name>/worker.capnp apps/<name>/package.json
cd apps/<name> && bun install && bun run typecheck && bun run build
cd ../.. && bun run dev    # then: curl -XPOST -d '{"text":"hi"}' -H 'content-type: application/json' localhost:8080/<name>/notes
```

| File | Purpose |
|---|---|
| `src/worker.ts` | Hono routes and the `Db` Durable Object, whose RPC methods run the Drizzle queries |
| `src/db/schema.ts` | tables; after a change run `bun run db:generate`, then commit `drizzle/` |
| `drizzle/` | generated migrations, bundled into `dist/worker.js` and applied when the object wakes up |
| `worker.capnp` | the `Db` namespace (`enableSql = true`) and its storage in `disk:<name>` |

Dependencies use caret ranges and the template commits `bun.lock`; don't use `"latest"`. The `__APP__` placeholder
appears in the `disk:` service name (it must match the folder name, see the rules above) and in the namespace's
`uniqueKey`.

A single Durable Object is only safe with one workerd instance (see [Using all CPU cores](#using-all-cpu-cores-optional)).
For several instances, keep the schema and routes and switch the driver to libSQL (see [Database](#database)).
Small per-object state, like a status row in `apps/do-test`, can stay on `ctx.storage.get`/`put` or one `sql.exec`.

For a full app with a React UI, JWT auth and D1/R2 or libSQL/S3, follow
[docs/spec-hono-workerd.md](docs/spec-hono-workerd.md), a spec written for coding agents.

### Directory structure for several apps

```
workerd-gateway/
├── gen.ts                  codegen
├── src/gateway.ts          router (built to dist/gateway.js)
├── config.capnp            generated, gitignored
├── data/cron/              cron scheduler state, gitignored
├── deploy/                 systemd, nginx and Caddy examples
└── apps/
    ├── app-1/              app-1.mydomain.com, localhost:8080/app-1/
    │   ├── worker.capnp    const worker :Workerd.Worker
    │   ├── cron.json       optional: ["0 3 * * *"]
    │   └── dist/
    │       └── worker.js   built by app-1's own build
    ├── app-2/  -> ~/codes/app-2          symlink to a repo elsewhere
    │   ├── worker.capnp
    │   └── dist/worker.js
    └── app-3/              git submodule
        ├── worker.capnp
        ├── package.json    its own build script
        ├── src/index.ts
        └── dist/worker.js
```

An app can live here directly, be a symlink to its repo, or be a git submodule. The only contract is
`apps/<name>/worker.capnp`. For each app, build it first (`cd apps/app-3 && bun run build`), then run `bun gen.ts` once
for all of them.

### What an app receives

- **Path:** with path routing, the gateway strips `/<name>` before forwarding and sets
  `X-Forwarded-Prefix: /<name>`. Use the header if the app builds absolute links. `/<name>` without a trailing slash
  redirects (308) to `/<name>/` so relative links resolve.
- **Host, method, query, body and other headers:** forwarded as received, including `X-Forwarded-*` from nginx or
  Caddy.
- **Calls between gateway and app:** a service binding call runs inside the same process. There's no network hop.

## Environment variables and secrets

Secrets reach an app as bindings declared in its own `worker.capnp`, usually
`(name = "API_KEY", fromEnvironment = "APP_A_API_KEY")`. workerd reads them from its process environment once, at
startup. Each request then finds them on `env` (`env.API_KEY`). Prefix the variable names per app (`APP_A_`, `APP_B_`),
because all apps share one process environment. Never put a secret in a `text = "..."` binding: that writes the value
into a file that gets committed.

`gen.ts` never reads secret values. It only generates structure, so nothing secret ends up in `config.capnp`.

There are three ways to supply the values.

### 1. Infisical CLI

`infisical run` fetches the secrets and starts workerd with them in its environment:

```bash
infisical run --env=prod -- bunx workerd serve config.capnp --experimental
```

Under systemd, put `INFISICAL_TOKEN` (a machine identity token) in the unit's `EnvironmentFile` and wrap `ExecStart`
the same way (see the commented line in `deploy/workerd-gateway.service`). Store names in Infisical already prefixed
(`APP_A_API_KEY`), or use one Infisical path per app.

### 2. Your own launcher for another secrets manager

For a secrets manager without a CLI, write a launcher that fetches each app's secrets, adds them to the environment
with that app's prefix, and then starts workerd:

```ts
// launch.ts: bun launch.ts -- workerd serve config.capnp --experimental
let cmd = Bun.argv.slice(2);
if (cmd[0] === "--") cmd = cmd.slice(1);

const env: Record<string, string | undefined> = { ...process.env };
for (const prefix of ["APP_A", "APP_B"]) {
  const secrets: Record<string, string> = await fetchSecretsFor(prefix); // your secrets manager's client
  for (const [k, v] of Object.entries(secrets)) env[`${prefix}_${k}`] = v;
}
// Remove the launcher's own credentials so workerd only gets the values.

const child = Bun.spawn(cmd, { env, stdio: ["inherit", "inherit", "inherit"] });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
process.exit(await child.exited);
```

Options 1 and 2 share the same trade-offs:

- **Restart to rotate:** a new secret value takes effect only after workerd restarts.
- **Plaintext in the process environment:** root and the service user can read it from `/proc/<pid>/environ`.
- **Unchanged app code:** apps only ever read `env.X`, so the code works on Cloudflare too. There, push the same values
  into Worker secrets at deploy time.

### 3. Fetch at runtime, on the first request (cold start)

The app holds only the secrets manager's client credentials as bindings and fetches its secrets itself. Global scope
can't do I/O, so the fetch happens on the first request, and a module-level cache keeps the result:

```ts
const TTL = 5 * 60_000;
let cache: { at: number; p: Promise<Record<string, string>> } | undefined;

function secrets(env: Env) {
  if (!cache || Date.now() - cache.at > TTL) {
    const p = fetchSecrets(env.SM_CLIENT_ID, env.SM_CLIENT_SECRET); // your secrets manager's client
    cache = { at: Date.now(), p };
    p.catch(() => { if (cache?.p === p) cache = undefined; }); // retry on the next request
  }
  return cache.p;
}

export default {
  async fetch(req: Request, env: Env) {
    const { DATABASE_URL } = await secrets(env);
    // ...
  },
};
```

Trade-offs:

- **Network round trip on every cold start.** In workerd, an isolate lives as long as the process, so a cold start
  means the first request after each start or restart, and once more every TTL. With N instances (see below), each
  instance fetches on its own. On Cloudflare, isolates are evicted often, so the first request on every new isolate
  pays the round trip.
- **Runtime dependency:** if the secrets manager is down, cold requests fail, though warm isolates keep working
  from cache.
- **Rotation without restart:** new values arrive once the TTL expires. Only the client credentials sit in the process
  environment.
- **Private address needs a network service:** workerd's default outbound access only reaches public addresses. If
  the secrets manager is on loopback, set `globalOutbound = "net"` in the app's `worker.capnp` (see
  [App folder format](#app-folder-format)). For a private-network address, `net` would also need `"private"` in its
  `allow` list, which `gen.ts` doesn't add.

## Running under systemd

One instance is enough for most setups. Install the repo at `/opt/workerd-gateway`, build it, generate the config,
create a `workerd` system user, and install `deploy/workerd-gateway.service`:

```bash
sudo useradd --system --no-create-home workerd
cd /opt/workerd-gateway && bun install && bun run build && bun gen.ts
sudo cp deploy/workerd-gateway.service /etc/systemd/system/
sudo install -m 600 -o root /dev/null /etc/workerd-gateway/env    # secrets, if any
sudo systemctl daemon-reload && sudo systemctl enable --now workerd-gateway
```

After changing apps: `bun gen.ts && sudo systemctl restart workerd-gateway`.

The unit runs `workerd serve config.capnp --experimental`, because the built-in cron scheduler needs that flag. With
`ProtectSystem=strict`, the only writable path is `/opt/workerd-gateway/data`, where the scheduler keeps its state.

workerd listens on `127.0.0.1:8080` only. Put nginx (`deploy/nginx.conf`) or Caddy (`deploy/Caddyfile`) in front for
TLS and subdomains. nginx needs `proxy_set_header Host $host;`: without it, nginx sends `127.0.0.1:8080` as the host and
subdomain routing breaks. Caddy forwards the original host by default.

## Using all CPU cores (optional)

workerd runs all JavaScript on one thread per process, so one instance uses one core for request handling. You only
need more instances for high-load I/O or compute-heavy apps, where that one core is saturated. Otherwise, stay with one
instance.

To scale out, keep `workerd-gateway.service` on port 8080. It's the only instance that runs crons. Add one template
instance per extra core, generated without crons, and load balance across all of them:

```bash
bun gen.ts --no-cron --out config.lb.capnp
sudo cp deploy/workerd-gateway@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now workerd-gateway@{8081..8083}    # with 8080: 4 cores
```

`--socket-addr http=127.0.0.1:%i` in the template unit overrides the socket address from `config.lb.capnp`, so the
extra instances share one generated config. Then use `deploy/nginx-lb.conf` or `deploy/Caddyfile.lb`, which spread
requests across 8080 to 8083 with `least_conn`. Caddy also health-checks `/_gateway/health`.

Crons must run in exactly one instance. If every instance ran the scheduler, either each would fire every job (with
separate state directories), or they would share one Durable Object's SQLite file (with the same directory), which
risks corruption.

Trade-offs:

- **More RAM.** Every instance is a full workerd process that loads its own isolate for the gateway and for every app.
  Memory grows roughly as instances × (process baseline + every app's isolate). With the gateway and one trivial app,
  one instance measured about 60 MB RSS; real apps add their own heap and code size on top. Four instances means four
  copies of everything.
- **State is per instance.** Module-scope caches, in-memory data and Durable Objects exist separately in each process.
  Never point several instances at the same Durable Object `localDisk` storage: the same object would run twice over
  one SQLite file, which leads to conflicting writes or corruption. Route stateful apps to a single instance, or keep
  their state in an external database.
- **Secrets are fetched per instance.** With runtime fetching (option 3), each instance pays its own cold start.

## Background tasks and state: Durable Objects

**The principle: Durable Objects replace background tasks and in-process state.** Where a Node, Bun, Python or Go
server would start a thread, a goroutine, a background promise or a job-queue worker, an app in this hub starts a
Durable Object. Don't add a separate long-running service for it.

workerd gives an app no background thread of its own. A request's work ends with the request, module-scope variables
are lost on restart and exist separately in each instance, and a busy loop stalls every app on the instance. A Durable
Object is a named, single-threaded object with its own SQLite database and an alarm that wakes it up. It comes into
existence on its first call, is evicted from memory when idle (costing nothing while it waits), and picks up from its
storage after a restart. The same code runs on Cloudflare.

| Traditional server | Durable Object |
|---|---|
| Spawn a thread or background job, return `202` | `stub.start(input)` saves the input, sets an alarm, returns at once |
| Job loop: `while (!done) step()` | `alarm()` runs one step, saves progress, sets the next alarm |
| In-memory job map, `Map<jobId, Job>` | one object per job or session, `idFromName(id)`, state in its SQLite |
| Queue worker with retries | an `alarm()` that throws is retried with backoff (`alarmInfo.retryCount` counts attempts) |
| WebSocket server and subscriber list | `ctx.acceptWebSocket()` and `ctx.getWebSockets()` in the same object |
| Worker pool, fan-out | child objects, each calling the parent back by RPC when done |
| Mutex around shared state | none: an object handles one event at a time |
| A crash loses running jobs | the pending alarm fires again after a restart, and the job resumes at its last checkpoint |

`apps/do-test` is a working example: `GET /do-test/run-task/user1` starts user1's object, which logs five simulated
tasks 10 seconds apart and then writes `data/apps/do-test/results/user1.txt`. `/do-test/status/user1` and
`/do-test/result/user1` report on it. Kill workerd mid-run and start it again, and the run continues where it stopped.

The shape of a real job, for example an LLM agent loop:

```ts
export class Job extends DurableObject<Env> {
	async start(input: Input) {                       // RPC from the app's fetch handler
		this.save({ input, step: 0 });
		await this.ctx.storage.setAlarm(Date.now());   // run the first step right away
	}

	override async alarm() {
		const state = this.load();
		const next = await step(state);                // one LLM call or one sidecar call: awaiting is fine
		this.save(next);                               // checkpoint before scheduling the next step
		if (next.done) await this.finish(next);
		else await this.ctx.storage.setAlarm(Date.now());   // next step now; a pause is just a later time
	}

	async finish(result: Result) {
		await storeResult(result);                     // database, object store or file: wherever it lives on
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();            // only after the result is safely stored
	}
}
```

Rules that keep it correct:

- **One step per alarm.** Awaiting I/O inside a step is fine, however long the LLM takes to answer. Keep CPU work
  short, since it runs on the shared thread.
- **Checkpoint every step, and expect repeats.** A step that throws runs again from the start, so an LLM call in it is
  made and paid for again. Save expensive results as soon as they arrive, and check storage before repeating them.
- **One alarm per object.** `setAlarm()` replaces the pending alarm. If an object needs several timers (the next step
  and a watchdog, say), keep them in a table and always set the alarm to the earliest.
- **Fan out to child objects, and never await them.** The parent starts N children at a time (an API rate limit is
  usually the real bound), each child runs its own alarm chain, and reports back with `parent.childDone(id, result)`
  or `parent.childFailed(id, error)`. The parent starts the next child, or the next phase once all are done.
- **Keep large data out of the object.** Page images, uploads and exports go to the object store. The object keeps
  their keys and small JSON.
- **Clean up yourself.** Nothing expires on its own, here or on Cloudflare. Call `deleteAll()` when a job ends, and
  give idle jobs a timeout (an alarm a few days out that finishes or discards an abandoned job). In workerd,
  `deleteAll()` empties the object's SQLite file but leaves a small empty file behind for every object name ever
  used, so prefer names that are reused (one per user or per session) to one per job, or remove empty `<hash>.sqlite`
  files while workerd is stopped. On Cloudflare, an emptied object holds no billable storage.
- **One instance.** An app's objects live in the `data/apps/<name>` directory of the one instance that owns it (see
  [App folder format](#app-folder-format) and [Using all CPU cores](#using-all-cpu-cores-optional)).

**When a separate service is still the answer:** work workerd can't do, such as starting processes, native libraries
(PDF rendering, image processing) or long CPU-bound computation. Keep the job itself in a Durable Object and call the
service once per step over HTTP. To keep it lazy instead of always running, start it with systemd socket activation,
so it starts on the first connection and can exit when idle:

```ini
# /etc/systemd/system/pdf-render.socket
[Socket]
ListenStream=127.0.0.1:9100

[Install]
WantedBy=sockets.target

# /etc/systemd/system/pdf-render.service: started by the first connection to the socket.
# The program takes the listening socket from systemd (LISTEN_FDS) and exits after a while with
# no requests. A program that can't do that can sit behind systemd-socket-proxyd --exit-idle-time.
[Service]
ExecStart=/usr/local/bin/pdf-render
```

### Several timers per object: `@cloudflare/actors` (optional)

[`@cloudflare/actors`](https://github.com/cloudflare/actors) is Cloudflare's library on top of Durable Objects. Its
main use here is `this.alarms`: any number of pending timers per object, each calling a named method with its own
payload. It keeps them in a table and points the one real alarm at the earliest, which is the bookkeeping the
"one alarm per object" rule above otherwise leaves to you.

`apps/reminders` is the example. Each user is one actor, and each reminder is one timer. Every route is a GET, so
you can try them in a browser (a real app would use POST and DELETE for the ones that change state):

```
http://localhost:8080/reminders/alice?in=10&text=tea      {"id":"...","at":"...","text":"tea"}
http://localhost:8080/reminders/alice?in=60&text=stretch  a second timer; the first stays pending
http://localhost:8080/reminders/alice                     pending reminders
http://localhost:8080/reminders/alice/cancel/<id>         cancel one
```

```ts
const s = await this.alarms.schedule(10, "remind", { text }); // seconds, a Date, or a cron string
this.alarms.getSchedules();                                   // pending timers
await this.alarms.cancelSchedule(s.id);
```

Under workerd, scheduling, listing, cancelling, firing and resuming after a restart all work (tested with
`0.0.1-beta.6`).

Use it when an object needs **several independent timers** at once: reminders, per-item expiry, a step timer plus a
watchdog. Don't use it for a single alarm chain like `apps/do-test` or a repeating counter: `setAlarm()` in
`alarm()` is a few lines and has no dependency.

What to know before using it:

- **It's beta** (`0.0.1-beta.x`). The API may change between releases. Pin the exact version.
- **It needs a build step.** It's an npm package, so the app is bundled with `bun build`, with `cloudflare:*` kept
  external (see `apps/reminders/package.json`). The bundle is about 50 KB, compared with a few KB for a plain object.
- **The binding must be named exactly like the class.** The library finds the namespace with
  `import { env } from "cloudflare:workers"` and looks for a binding with the class's name. In `worker.capnp`:
  `(name = "Reminders", durableObjectNamespace = "Reminders")`. Any other name fails with `No Durable Object binding
  found for actor class Reminders`.
- **It needs SQLite storage** (`enableSql = true`). It adds its own tables to the object's database (`_actor_alarms`
  for timers, `_actor_persist` for `@Persist` fields). Your own tables share that database, so don't use those names.
- **A failed timer is not retried.** If the callback throws, the library logs the error and deletes the timer
  (a cron timer moves to its next time). A plain `alarm()` that throws is retried with backoff. For work that must
  succeed, catch the error in the callback and schedule the timer again yourself.
- **Times are whole seconds.** Due times are rounded down to the second, so a timer can fire up to a second early.
- **Don't override `alarm()`.** The base class's `alarm()` runs the timers. To run code on every wake-up, override
  `onAlarm()` instead, or call `super.alarm()`.
- **`handler(MyActor)` covers only `fetch`.** It finds the instance with the static `nameFromRequest(req)` (which
  answers `500 Invalid actor identifier` when it returns `undefined`), forwards the request to the actor's
  `onRequest()`, and leaves the routing inside to you. An app that also needs `scheduled()` or its own routing in
  front writes its own default export and uses `MyActor.get(name)` for the stub.
- **It's Cloudflare-shaped.** Its docs assume Wrangler, and some features (location hints, the `track` option's
  instance list) mean nothing or add an extra object on a single server. The timers, `@Persist` and SQL migrations
  are the parts that carry over.

## Scripts

| Command | Does |
|---|---|
| `bun run build` | builds `src/gateway.ts` to `dist/gateway.js` |
| `bun gen.ts` | generates `config.capnp` from `apps/*/worker.capnp` and `cron.json` |
| `bun run dev` | build, generate, then `workerd serve config.capnp --experimental --verbose` |
| `bun run start` | `workerd serve config.capnp --experimental` |
| `bun run typecheck` | `bun check` |

## Recommended companion services

The hub runs only Workers. Following the lean idea, each need gets **one default**. Alternatives are listed in one
line and are only worth it when the default falls short.

| Need | Default | Also works |
|---|---|---|
| HTTP routing, input validation | [Hono](https://hono.dev) with `@hono/zod-validator` (see [Starting a new app](#starting-a-new-app-hono--drizzle)) | plain `fetch` handler, for an app with one or two routes |
| Queries | [Drizzle](https://orm.drizzle.team) (`drizzle-orm/libsql`, `drizzle-orm/durable-sqlite`, `drizzle-orm/postgres-js`) | `ctx.storage.get`/`put` for small per-object state |
| Scheduled jobs | workerd's built-in cron (`cron.json`) | systemd timer, your own scheduler |
| Background tasks, job state | Durable Objects with alarms (built in, see [above](#background-tasks-and-state-durable-objects)) | a socket-activated service, only for work workerd can't do |
| Secrets | `fromEnvironment` bindings filled by `infisical run` | env file, OpenBao or Vault, SOPS, your own launcher |
| Files and media | [RustFS](https://rustfs.com) (S3 API) | MinIO, Garage, SeaweedFS, Cloudflare R2 |
| Database | [libSQL / sqld](https://github.com/tursodatabase/libsql) | SQLite in a Durable Object (one instance only), PostgreSQL |
| Cache | none: module-scope cache, then the database | Valkey or Redis, once instances must share a cache |
| Logs | journald (`journalctl -u workerd-gateway -f`) | Vector or Grafana Alloy into Loki |

Services other than cron and logs run next to workerd, usually on localhost or a private network. workerd's default
outbound access only reaches public addresses, so an app that calls them sets `globalOutbound = "net"` in its
`worker.capnp`, and `gen.ts` declares `net` (public plus loopback). Services on a private network would also need
`"private"` in its `allow` list, which `gen.ts` doesn't add.

### Scheduled jobs (cron)

The default is the cron scheduler built into workerd (`/workerd/cron.js`, workerd 2026-11 and later). Add a `cron.json`
next to an app's `worker.capnp`:

```json
["0 3 * * *", "*/15 * * * *"]
```

and a `scheduled()` handler to the app, the same handler Cloudflare Workers cron triggers call:

```ts
export default {
  async fetch(req, env) { /* ... */ },
  async scheduled(controller, env, ctx) {
    // controller.cron: the expression that fired; controller.scheduledTime: when, in ms
  },
};
```

`bun gen.ts` adds the scheduler to `config.capnp`. Each schedule is a SQLite-backed Durable Object stored in
`data/cron`, woken by its alarm. It behaves like this:

- **Expressions:** Cloudflare's dialect, in UTC. Day of week counts 1 to 7 from Sunday, so `1-5` means Sunday to
  Thursday, unlike Vixie cron. Use names (`MON-FRI`) to avoid the surprise.
- **Delivery:** at least once. A run that throws or takes longer than 10 minutes is retried up to 6 times, with backoff
  starting at 2 seconds.
- **Startup:** workerd arms every schedule when it starts. State survives restarts in `data/cron`.

Why it's the default: it needs nothing outside workerd, there's no HTTP endpoint to protect, retries are built in, and
the app code and cron expressions move to Cloudflare unchanged.

Its costs:

- **Experimental flag.** It needs `--experimental`, which the scripts and units already pass. It may change or go
  away in a future workerd release. Read the changelog before you upgrade the pinned `workerd` version.
- **One instance only.** With several instances, only the one running `config.capnp` may have it (see
  [Using all CPU cores](#using-all-cpu-cores-optional)).

**Fallback: systemd timer.** It's stable, independent of workerd, visible in `systemctl list-timers`, and runs once no
matter how many instances there are. It calls an HTTP endpoint on the app:

```ini
# /etc/systemd/system/app-a-daily.service
[Service]
Type=oneshot
EnvironmentFile=/etc/workerd-gateway/env
ExecStart=/usr/bin/curl -fsS -X POST -H "Authorization: Bearer ${APP_A_CRON_TOKEN}" http://127.0.0.1:8080/app-a/_cron/daily

# /etc/systemd/system/app-a-daily.timer
[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

**That endpoint must check the token.** nginx and Caddy expose every app path publicly. A systemd timer doesn't retry
on its own, and the endpoint is specific to this setup, so it doesn't port to Cloudflare. For queues or job history,
use Durable Objects (see [Background tasks and state](#background-tasks-and-state-durable-objects)) rather than a
scheduler service of your own.

### Files and media

Call RustFS (or any S3-compatible store) from a Worker with [`aws4fetch`](https://github.com/mhart/aws4fetch), which
only needs `fetch` and WebCrypto. The same code works against Cloudflare R2's S3 endpoint. For large uploads, hand the
browser a presigned URL instead of streaming the file through the Worker. If you consider MinIO, check its current
license and how the community edition is distributed.

### Database

libSQL runs SQLite as a server over HTTP. Use `@libsql/client/web` from Workers. Drizzle supports it
(`drizzle-orm/libsql`), and it stays correct with any number of workerd instances because the state lives outside them.
SQLite in a Durable Object (`drizzle-orm/durable-sqlite`) needs no extra service, but it's only safe with one instance.
