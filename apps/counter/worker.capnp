using Workerd = import "/workerd/workerd.capnp";

# Counter example: one `Counter` Durable Object per counter name, holding a single number.
# Plain JS, so no build step. "disk:counter" is created by gen.ts as data/apps/counter (writable),
# where the objects' SQLite files live (data/apps/counter/counter/).
const worker :Workerd.Worker = (
  modules = [ (name = "worker", esModule = embed "worker.js") ],
  compatibilityDate = "2026-11-01",
  durableObjectNamespaces = [ (className = "Counter", uniqueKey = "counter", enableSql = true) ],
  durableObjectStorage = (localDisk = "disk:counter"),
  bindings = [ (name = "COUNTERS", durableObjectNamespace = "Counter") ],
);
