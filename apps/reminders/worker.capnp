using Workerd = import "/workerd/workerd.capnp";

# @cloudflare/actors example: one `Reminders` actor per user, holding any number of timers.
# Source in src/worker.ts; `bun run build` writes dist/worker.js.
# The library finds the namespace by binding name, so the binding must be named exactly like
# the class ("Reminders"). It keeps its timers in SQLite, so enableSql is required.
# "disk:reminders" is created by gen.ts as data/apps/reminders (writable).
const worker :Workerd.Worker = (
  modules = [ (name = "worker", esModule = embed "dist/worker.js") ],
  compatibilityDate = "2026-11-01",
  durableObjectNamespaces = [ (className = "Reminders", uniqueKey = "reminders", enableSql = true) ],
  durableObjectStorage = (localDisk = "disk:reminders"),
  bindings = [ (name = "Reminders", durableObjectNamespace = "Reminders") ],
);
