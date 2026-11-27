using Workerd = import "/workerd/workerd.capnp";

# App template: Hono + Drizzle on a SQLite-backed Durable Object. Source in src/worker.ts;
# `bun run build` writes dist/worker.js. "disk:__APP__" is created by gen.ts as data/apps/__APP__
# (writable) and holds the Durable Object's SQLite file.
const worker :Workerd.Worker = (
  modules = [ (name = "worker", esModule = embed "dist/worker.js") ],
  compatibilityDate = "2026-11-01",
  durableObjectNamespaces = [ (className = "Db", uniqueKey = "__APP__-db", enableSql = true) ],
  durableObjectStorage = (localDisk = "disk:__APP__"),
  bindings = [
    (name = "DB", durableObjectNamespace = "Db"),
  ],
);
