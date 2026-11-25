using Workerd = import "/workerd/workerd.capnp";

# Durable Object example: one `Run` object per user, stepping through 5 simulated tasks.
# Source in src/worker.ts; `bun run build` writes dist/worker.js.
# "disk:do-test" is created by gen.ts as data/apps/do-test (writable). It holds the objects'
# SQLite files (data/apps/do-test/do-test-run/) and the results (data/apps/do-test/results/).
const worker :Workerd.Worker = (
  modules = [ (name = "worker", esModule = embed "dist/worker.js") ],
  compatibilityDate = "2026-11-01",
  durableObjectNamespaces = [ (className = "Run", uniqueKey = "do-test-run", enableSql = true) ],
  durableObjectStorage = (localDisk = "disk:do-test"),
  bindings = [
    (name = "RUNS", durableObjectNamespace = "Run"),
    (name = "FILES", service = "disk:do-test"),
  ],
);
