using Workerd = import "/workerd/workerd.capnp";

# The one thing gen.ts needs from an app: a const named `worker` of type Workerd.Worker.
# Paths in `embed` are relative to this file.
const worker :Workerd.Worker = (
  modules = [ (name = "worker", esModule = embed "worker.js") ],
  compatibilityDate = "2026-11-01",
);
