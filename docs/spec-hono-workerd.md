# Project Spec: Hono + React SPA + Drizzle on workerd or Cloudflare (MVP)

This spec is for an LLM coding agent to follow. It is the
[TanStack Start spec](https://gist.githubusercontent.com/vmasdani/5c09a8367295d1119fbce51e2db3e4ed/raw/ba908e37f81f8750f4d9de321390441fc48b8d79/spec-final-tanstack.md)
adapted to Workers: a Hono API and a React single-page app (SPA) in one Worker. That Worker deploys to Cloudflare
(D1, R2) or runs self-hosted in this repo's workerd gateway (libSQL, RustFS).

The spec is built around a few rules, so that an agent has one obvious path at each step and can check its own work:

- **One default per need.** No step asks the agent to choose a library.
- **Fixed paths.** Every file the spec mentions has one location (see [Project layout](#project-layout)).
- **Types from end to end.** The Drizzle schema types the database, Hono RPC types the API, and the browser imports
  the API's type. A broken contract fails `bun run typecheck`, not production.
- **Checks enforce the rules.** Wherever possible, a rule comes with a script that fails when the rule is broken.
  `bun run verify` runs them all. Work isn't done until it passes.

## How to use this spec

1. **Choose the target once, at scaffold time:** `cloudflare` or `selfhost`. Record it as `"target"` in
   `config.json`. Build only that target's files: the codebase contains one target, not both. Wherever this spec shows
   two columns, follow only your target's column.
2. Follow the sections in order: scaffold, then the rules, then the features.
3. After each meaningful change, run `bun run verify`. Don't claim completion until it passes, or report exactly what
   still fails.

| | `cloudflare` | `selfhost` (this repo's [README](../README.md)) |
|---|---|---|
| Runtime | Cloudflare Workers | workerd, as one app in this repo's gateway (`apps/<name>`, a symlink to the project) |
| Database | D1 (`drizzle-orm/d1`) | libSQL / sqld (`drizzle-orm/libsql/web`) |
| Files | R2 binding | RustFS or any S3-compatible store, via `aws4fetch` |
| SPA assets | Workers static assets | embedded in `dist/worker.js` by `scripts/build-worker.ts` |
| Secrets in prod | `cf deploy --secrets-file` | Infisical (`infisical run`), names prefixed per app |
| CLI | `cf` (needs Node.js 22.18+; `cf` doesn't run on Bun) | `bun`, `workerd`, `systemctl` |
| Instances | any | any (state lives in libSQL, not in workerd) |

Both targets use the SQLite dialect, so the schema, queries and migrations are written the same way. Only the driver
and the migration command differ.

## Changes from the TanStack Start spec

| TanStack Start spec | This spec | Why |
|---|---|---|
| TanStack Start (SSR) | Hono API plus a Vite-built React SPA, in one Worker | runs unchanged on workerd and Cloudflare. Without SSR there's no hydration mismatch class of bugs |
| pnpm | Bun | this repo's default. `cf` itself needs Node.js |
| PostgreSQL | D1 or libSQL (SQLite dialect) | the default database for each target (README → Database) |
| `drizzle-kit push` before start | `drizzle-kit generate` plus apply, with the SQL committed | D1 is applied with `cf d1 migrations apply`. Committed SQL lets a script reject destructive migrations |
| `db.transaction` for multi-step writes | `db.batch([...])` | D1 has no interactive transactions. `batch` is atomic on D1 and libSQL |
| Zod only for env | Zod for env **and** API input (`@hono/zod-validator`); forms still don't use Zod | typed `c.req.valid()` and typed RPC client inputs. Matches `templates/app` |
| `createServerFn` and its separate auth rules | none; every server operation is an `/api/*` route | one auth path, no bypass class |
| `src/env.ts` parsed from `process.env` at load time | `getEnv(c.env)`: parsed on first use, then cached | Workers bindings arrive on `env`, not `process.env` |
| argon2id | PBKDF2-SHA256 through WebCrypto, 100,000 iterations | native argon2 doesn't run in workerd. 100,000 is the most Workers allows |
| `crypto.timingSafeEqual` (Node) | `crypto.subtle.timingSafeEqual` over SHA-256 digests | the Workers API. Digests make the lengths equal |
| `config.json` committed, holding prod secrets | `config.json` gitignored, `config.example.json` committed | secrets stay out of git |
| `APP_SECRET` example `"dev-app-secret"` | 32+ character examples | the original example fails its own `min(32)` |

## Stack

| Concern | Choice |
|---|---|
| Package manager and scripts | Bun (`bun install`, `bun run`, `bunx`) |
| API | Hono, with `@hono/zod-validator` for input. Routes are chained so `hono/client` can infer `AppType` |
| Frontend | React 19, Vite, TanStack Router (file-based routes, browser history) |
| UI | shadcn/ui (Vite setup), Tailwind v4, lucide-react |
| ORM | Drizzle ORM, SQLite dialect (`drizzle-orm/sqlite-core`), drizzle-kit |
| Client state | Zustand (`persist`, cross-tab sync), `useImmer` for complex local state |
| Validation | Zod for env and API input only |
| Theme | next-themes (light, dark, system) |
| Toasts | sonner |
| JWT | jose (WebCrypto). Never `jsonwebtoken` |
| Password hashing | PBKDF2-SHA256 through `crypto.subtle` (see [Password hashing](#password-hashing)) |
| S3 client (selfhost) | aws4fetch |

Don't add: TanStack Query, TanStack Form, TanStack Table, TanStack DB, Express, axios, an extra router, an extra ORM,
or `node:` APIs in server code (no `nodejs_compat` flag). Every dependency in `package.json` gets a caret version;
never `"latest"`. Commit `bun.lock`.

Vite is the one exception to this repo's Bun-native bundling: shadcn, the TanStack Router plugin and `cf` all
integrate with Vite. The self-hosted Worker itself is bundled with `Bun.build`.

## Project layout

```
<project>/
├── manage.py                    environment launcher (the only way to build and run)
├── config.example.json          committed; copy to config.json (gitignored)
├── template.env                 placeholders, rendered by manage.py
├── index.html                   SPA document: title, description, favicon
├── vite.config.ts               SPA build to dist/web, TanStack Router plugin, /api dev proxy (selfhost)
├── components.json              shadcn, "@" -> src/web
├── drizzle.config.ts
├── drizzle/                     generated migrations, committed, never edited by hand
├── cloudflare.config.ts         cloudflare target only
├── worker.capnp                 selfhost target only
├── scripts/
│   ├── build-worker.ts          selfhost only: bundles src/server + dist/web into dist/worker.js
│   ├── db-apply.ts              applies drizzle/ to the database in .env (target-aware)
│   ├── check-migrations.ts      fails on destructive SQL in drizzle/
│   └── check-boundaries.ts      fails when src/web imports server code at runtime
├── tsconfig.server.json         lib ESNext, types @cloudflare/workers-types, include src/server src/shared
├── tsconfig.web.json            lib ESNext DOM, types @cloudflare/workers-types, include src/web src/shared
└── src/
    ├── shared/                  types and constants used by both sides, with no imports from server or web
    ├── server/
    │   ├── app.ts               builds the Hono app and exports `type AppType`
    │   ├── entry.ts             the Worker's default export (target-specific, see Deployment)
    │   ├── env.ts               Zod schema and getEnv()
    │   ├── types.ts             Hono `Env` type: Bindings and Variables
    │   ├── middleware/          db.ts, auth.ts, errors.ts
    │   ├── lib/                 auth.ts (jose), password.ts, storage.ts
    │   ├── db/                  index.ts (client), columns.ts, schema.ts (or schema/ with index.ts)
    │   ├── repositories/        every query lives here
    │   └── routes/              auth.ts, <feature>.ts: one Hono sub-app each
    └── web/
        ├── main.tsx             router, providers (theme, toaster)
        ├── routes/              TanStack Router file routes (__root.tsx, login.tsx, _app/...)
        ├── routeTree.gen.ts     generated by the router plugin, committed
        ├── components/          app components; components/ui/ is shadcn's
        ├── lib/api-client.ts    the only browser fetch path
        └── stores/              Zustand stores
```

The browser code (`src/web`) may import from the server only with `import type`, and only `AppType` and the types
it exposes. `scripts/check-boundaries.ts` fails on any other import from `src/web` into `src/server`. Server code never
imports from `src/web`.

## Initial scaffold

```bash
bun create vite@latest <name> --template react-ts
cd <name> && bun install
# Tailwind v4 and shadcn with the Vite setup (https://ui.shadcn.com/docs/installation/vite)
bunx shadcn@latest init
bunx shadcn@latest add dashboard-01 sidebar-07 login-01 sonner
bun add hono @hono/zod-validator zod drizzle-orm jose zustand immer use-immer next-themes @tanstack/react-router
bun add -d drizzle-kit @cloudflare/workers-types @tanstack/router-plugin
# cloudflare: cf init .          (adds cloudflare.config.ts and the Vite wiring; then edit it, see Deployment)
# selfhost:   bun add @libsql/client aws4fetch
```

Move the Vite app into `src/web` and point `components.json` aliases and the Vite `@` alias at `src/web`.

### Pre-implementation validation, in this order

1. **Confirm `src/web/components/ui/sidebar.tsx` and `src/web/components/app-sidebar.tsx` both exist.** If either
   is missing, **stop and report. Don't re-scaffold or recreate them.** They are the app's structural backbone.
   If they're missing, the scaffold didn't run correctly.
2. Inspect `package.json`, `src/web/routes/` (including `__root.tsx`), `src/web/components/` and the shadcn files.
3. Confirm the dashboard, sidebar and login block structure exists.
4. If Bun blocks a dependency's lifecycle script, add only that package to `trustedDependencies` and reinstall.
5. Run `bun run build` early, to see the baseline errors.
6. If a tooltip or other shadcn component errors, fix the scaffold or build before any feature work.

## UI rules

- Use shadcn components and blocks wherever possible. Add them with `bunx shadcn@latest add <component>`. Don't
  recreate a component by hand when the official one can be added.
- Adapt the sidebar and login page to the project. Remove default app names, default menu items and demo content.
- Don't add sidebar items for pages that don't exist and aren't in scope.
- Remove "Login with Google" unless OAuth is requested.
- Put a light, dark and system theme switch in the sidebar (next-themes).
- Use responsive layouts.
- Set the document title, description and favicon in `index.html`. Per-page titles go in the route's `head` option,
  rendered by `<HeadContent />` in `__root.tsx`.
- The login form has **`username`** and **`password`** fields (not email). Both are required. The button submits
  the actual field values to `/api/auth/login`. There's no bypass for empty fields; the API validates whatever arrives.

## Environment validation

Workers receive configuration as bindings on `env`, not in `process.env`. `src/server/env.ts` declares every
binding in one Zod schema and exports `getEnv(raw)`. The first call parses the bindings and caches the result, and
later calls reuse it. A missing or invalid value throws an error that names the variable. The error middleware turns
that into a `500` `{ error: "Server misconfigured: <issue>" }` and logs it. Validation is lazy, not at module load, so
on the shared gateway a misconfigured app fails its own requests and not workerd's startup.

```ts
// src/server/env.ts: server only. src/web must never import it (check-boundaries.ts enforces this).
import { z } from "zod";

const schema = z.object({
  JWT_SECRET: z.string().min(32),
  APP_SECRET: z.string().min(32), // external services; admin-equivalent; no default anywhere
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().min(1).default("admin"),
  // cloudflare target:
  DB: z.custom<D1Database>((v) => typeof v === "object" && v !== null, "D1 binding DB is missing"),
  FILES: z.custom<R2Bucket>((v) => typeof v === "object" && v !== null, "R2 binding FILES is missing"),
  // selfhost target, instead of DB and FILES:
  // LIBSQL_URL: z.url(), LIBSQL_AUTH_TOKEN: z.string().optional(),
  // S3_ENDPOINT: z.url(), S3_REGION: z.string().default("us-east-1"), S3_BUCKET: z.string().min(1),
  // S3_ACCESS_KEY_ID: z.string().min(1), S3_SECRET_ACCESS_KEY: z.string().min(1),
});

export type AppEnv = z.infer<typeof schema>;

let cached: AppEnv | undefined;
export function getEnv(raw: unknown): AppEnv {
  return (cached ??= schema.parse(raw));
}
```

- Server code reads configuration only through `c.get("env")`, which middleware sets from `getEnv(c.env)`. Never
  read `c.env.X` or `process.env` directly in feature code.
- The SPA has no runtime secrets. Build-time public values, if any, are `VITE_*` and read from `import.meta.env`
  in `src/web` only.

> **Production note:** the `admin`/`admin` defaults are for dev only. `manage.py` refuses to build or run the `prod`
> profile while `ADMIN_PASSWORD` is unset or `admin`. `APP_SECRET` has no default in any environment.

## Database rules

- Drizzle with the SQLite dialect (`drizzle-orm/sqlite-core`). The Drizzle schema is the single source of truth.
- The schema lives in `src/server/db/schema.ts`. For larger projects, split it by domain under
  `src/server/db/schema/` and re-export from `src/server/db/schema/index.ts`.
- Never create or change tables with hand-written SQL, and never define schema anywhere but Drizzle.
- Declare every table, column, relation, index, constraint and timestamp in the Drizzle schema. SQLite has no enum
  type: use `text("status", { enum: ["draft", "published"] })`, which is checked by TypeScript only.
- Index the fields that are likely to be searched: foreign keys, status fields, dates, and columns used in filters.

### Database client

`src/server/db/index.ts` exports `createDb(env)` and `type DB`. `middleware/db.ts` creates the client for each
request and sets it as `c.set("db", db)`. Don't keep a module-scope client: workerd refuses I/O on an object that
belongs to another request.

| `cloudflare` | `selfhost` |
|---|---|
| `drizzle(env.DB, { schema })` from `drizzle-orm/d1` | `drizzle(createClient({ url: env.LIBSQL_URL, authToken: env.LIBSQL_AUTH_TOKEN }), { schema })`, with `drizzle-orm/libsql/web` and `@libsql/client/web` |

On selfhost, `worker.capnp` sets `globalOutbound = "net"` so the Worker can reach sqld on loopback (README → App
folder format).

### Common columns: required on every table

```ts
// src/server/db/columns.ts
import { integer } from "drizzle-orm/sqlite-core";

const now = () => new Date();

export const commonColumns = {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now).$onUpdate(now),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
};
```

Spread `...commonColumns` into every table. `$onUpdate` sets `updatedAt` on every `db.update(...)`, with no
triggers. **Index `deletedAt` on every table.**

### Soft deletes: no hard deletes anywhere

- Every delete is soft: `db.update(table).set({ deletedAt: new Date() }).where(...)`.
- Every read filters `isNull(table.deletedAt)` by default. Repositories apply the filter in every list, get and
  find function, so features inherit it.
- Soft-deleted rows reach clients only through an explicit `includeDeleted` flag, on audit and admin paths.
- `db.delete(` doesn't appear in `src/server/routes` or `src/server/repositories`. `bun run verify` greps for it.

### The `users` table, for future user logins

The table is part of the essential schema, even though `/api/auth/login` doesn't read it in this MVP. It's there so
real accounts can be added later without schema work.

```ts
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { commonColumns } from "./columns";

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username", { length: 64 }).notNull().unique(), // unique creates the index
    password: text("password", { length: 255 }).notNull(), // PBKDF2 hash string when populated
    ...commonColumns,
  },
  (t) => [index("users_deleted_at_idx").on(t.deletedAt)],
);
```

### Password hashing

`src/server/lib/password.ts`. Native argon2 bindings don't run in workerd, and pure-JS argon2id at the recommended
memory cost would block the shared JavaScript thread. Use PBKDF2-SHA256 through `crypto.subtle`, with 100,000
iterations (the most Workers and workerd allow) and a random 16-byte salt per row. Store one self-describing string,
`pbkdf2-sha256$100000$<salt base64>$<hash base64>`, never a bare digest or a separate salt column. Verify by deriving
again and comparing with `crypto.subtle.timingSafeEqual`. Plaintext passwords are never stored or logged. Admin-created
users are hashed before insert, and there is no self-signup. `apps/access-control` in this repo has a working version
(`src/server/password.ts`).

### Schema evolution: additive only

Migrations are additive only, which makes applying them automatically on start safe.

**Allowed:**
- New tables.
- New columns that are nullable or have a SQL default (`.default(...)`). `$defaultFn` doesn't count: it runs in the
  app, so existing rows would have no value.
- New indexes.
- New values in a `text(..., { enum })` column.
- Foreign keys, but only on new tables. In SQLite, adding a foreign key to an existing table rebuilds the table.

**Forbidden:**
- Dropping or renaming tables or columns (Drizzle turns a rename into drop and add, which loses data).
- Changing a column's type, or making a nullable column `NOT NULL`.
- Anything that makes drizzle-kit rebuild a table (`__new_<table>`, then `DROP TABLE`).

`scripts/check-migrations.ts` reads every `drizzle/*.sql` and fails on `DROP TABLE`, `DROP COLUMN`, `RENAME`,
`ALTER COLUMN` and `__new_`. It runs in `bun run verify` and before every migration apply. A destructive change that's
truly needed is out of scope: handle it as a separate, supervised migration.

### Migrations

| Step | `cloudflare` | `selfhost` |
|---|---|---|
| `drizzle.config.ts` | `dialect: "sqlite"` (only generates; `cf` applies) | `dialect: "turso"`, `dbCredentials: { url, authToken }` from `.env` |
| After a schema change | `bun run db:generate` (`drizzle-kit generate`), then commit `drizzle/` | same |
| Apply (`bun run db:apply`) | `cf d1 migrations apply <D1_DATABASE_ID> --dir drizzle`, with `--local` for dev | `drizzle-kit migrate` |

`scripts/db-apply.ts` reads `TARGET`, `PROFILE` and the database settings from `.env`, which `manage.py` writes. It
runs `check-migrations.ts` first, then the command above (with `--local` for the cloudflare `dev` profile).
`manage.py run app dev` applies migrations before it starts anything, so dev always runs on an up-to-date database.
Prod applies come from `manage.py run app prod` only. There are no `predev` or `prestart` hooks: `manage.py` is the
one entrypoint.

## Files (R2 / S3), only when the project stores files

`src/server/lib/storage.ts` exports one interface, which the target implements:

```ts
export interface Storage {
  put(key: string, body: ReadableStream | ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<Response | null>; // body plus content-type, ready to return
}
```

| `cloudflare` | `selfhost` |
|---|---|
| `env.FILES.put` and `env.FILES.get` on the R2 binding | `AwsClient` from `aws4fetch`, signed requests to `${S3_ENDPOINT}/${S3_BUCKET}/${key}` |

- Record file metadata in a `files` table (key, content type, size, owner, plus `commonColumns`). A soft delete marks
  the row only. Removing the object is a separate, supervised cleanup job, out of scope.
- Generate object keys on the server (`crypto.randomUUID()` plus extension). Never use a client-supplied path.
- Downloads go through an authenticated `/api/files/:id` route. Buckets are private.
- Keep uploads through the Worker under 25 MB. Larger uploads need presigned URLs: out of scope for the MVP.

## Data access rules

- Every query lives in `src/server/repositories/<feature>.ts`. Repositories take `db` as their first argument and
  apply the soft-delete filter. Route handlers call repositories and never build queries inline.
- Use typed Drizzle queries. Raw `sql` fragments only where Drizzle has no builder, with a comment saying why.
- Multi-step writes use `db.batch([...])`, which is atomic on D1 and libSQL. Don't use `db.transaction(...)`: D1
  doesn't support it.

## Authentication

Lightweight JWT auth with **three transports**, so browser users, external user-facing clients and external services
all use the same backend:

1. **Browser sessions:** an `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` cookie named `token`. The cookie is the
   only place the browser keeps the token, and client-side JS can never read it.
2. **External user-facing clients** (mobile apps, third-party clients acting for a user):
   `Authorization: Bearer <token>`. The login response body includes the token for them.
3. **External services** (server-to-server, CI, integrations that don't represent a user): an `X-App-Secret` header
   equal to `APP_SECRET`. No login and no JWT. It grants admin-equivalent access, for trusted internal callers only.

Transports 1 and 2 use the same JWT. Transport 3 has no JWT.

### Login UX

- `username` and `password` fields, both required. "Remember me" sets the token's lifetime.
- The form always submits through `/api/auth/login`, and the API validates the submitted values.

### Token lifetime

- `rememberMe = false`: JWT `exp` is 24 hours, and the cookie's `Max-Age` is 24 hours.
- `rememberMe = true`: 30 days for both.

The cookie is set in both cases. Only the duration changes.

### `POST /api/auth/login`

In `src/server/routes/auth.ts`, validated with `zValidator("json", ...)`.

- **Body:** `{ username: string; password: string; rememberMe?: boolean }`
- **Check:** `username` must equal `ADMIN_USERNAME` and `password` must equal `ADMIN_PASSWORD`. Compare both in
  constant time: hash each side with SHA-256, then call `crypto.subtle.timingSafeEqual` on the digests. Never use
  `===` on secrets.
- **Match (200):** `{ token: string; user: { sub: string; username: string; admin: boolean; exp: number } }`. The
  token is signed for `{ sub: "admin", username: "admin", admin: true }`, with `iat` and `exp`. The cookie is set with
  `setCookie` from `hono/cookie`, using the flags above and a `maxAge` that matches the JWT.
- **Mismatch (401):** `{ error: "Invalid credentials" }`. No cookie, no token.
- **Replacement seam:** once `users` is wired up, the handler looks up the username and verifies the stored PBKDF2
  hash. For an unknown username, it still verifies against a fixed decoy hash, so the response time doesn't reveal
  whether the username exists. The request and response shapes don't change.

### `POST /api/auth/logout`

Clears the cookie with `deleteCookie(c, "token", { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })` and
returns `{ ok: true }`.

### JWT payload and utilities

```ts
// src/shared/auth.ts
export type SessionPayload = { sub: string; username: string; admin: boolean }; // jose adds iat, exp
```

Use the standard `exp` claim only, never a custom `expiresAt`. jose enforces `exp` during verification.
`src/server/lib/auth.ts` exports:

- `signSession(payload, ttlSeconds, secret): Promise<string>` (HS256)
- `verifySession(token, secret): Promise<SessionPayload | null>` (returns `null` on any failure, never throws)

## API authentication middleware

`src/server/middleware/auth.ts`, mounted in `app.ts` as `app.use("/api/*", authMiddleware)`. It skips the public
paths: `/api/auth/login` and `/api/auth/logout`. Don't make anything else public without an explicit reason. Pages
and assets don't go through this middleware.

### Order of checks

1. **`X-App-Secret` header present:** equal to `APP_SECRET` (constant-time) means a service, so continue. Otherwise
   `401`, with **no fallback** to the other transports.
2. **`Authorization: Bearer` present:** a valid JWT means a user, so continue. Invalid or expired means `401`, with
   **no fallback** to the cookie.
3. **`token` cookie present:** a valid JWT means a user, so continue. Otherwise `401`.
4. None of these: `401`.

The no-fallback rule stops an attacker from attaching a stale Bearer token or a wrong app secret to override a
legitimate cookie session. Every `401` is `{ error: "..." }`.

### Identity in context

On success the middleware calls `c.set("auth", ...)`, typed through `Variables` in `src/server/types.ts`:

```ts
export type AuthContext = {
  authMode: "user" | "service";
  userId: string; // JWT sub, or "service"
  userUsername: string; // JWT username, or "service"
  userAdmin: boolean; // always true for "service"
};

export type HonoEnv = {
  Bindings: Record<string, unknown>; // raw; read through c.get("env")
  Variables: { env: AppEnv; db: DB; auth: AuthContext };
};
```

Handlers read `c.get("auth")` and never verify the token again. Context is set on the server after verification and
can't come from the request, so clients can't spoof identity. Don't pass identity in request headers.

### CSRF

`SameSite=Lax` plus JSON-only mutation routes is enough for this MVP. Mutation routes reject a body that isn't
`application/json` (the Zod validator does this). There are no CSRF tokens.

## API shape and the typed client

- Errors: `{ error: string; code?: string }`, always. `middleware/errors.ts` (`app.onError`) maps a thrown
  `HTTPException` to its status, a Zod validation failure to `400`, and anything else to `500` without leaking the
  stack.
- Successes: a named typed shape, or `{ data: T }`. Be consistent and don't invent shapes per route.
- **Chain routes so the types flow.** Each `routes/<feature>.ts` is `new Hono<HonoEnv>().get(...).post(...)`, written
  as one expression. `app.ts` mounts them in one chain and exports the type:

```ts
// src/server/app.ts
const app = new Hono<HonoEnv>()
  .use("*", envMiddleware, dbMiddleware)
  .use("/api/*", authMiddleware)
  .route("/api/auth", auth)
  .route("/api/notes", notes);
app.onError(onError);

export type AppType = typeof app;
export default app;
```

A route added as a separate statement (`app.get(...)` on its own line) drops out of `AppType`. The browser client
then doesn't see it, so the typecheck catches the mistake only if the client calls it.

## State management

- Zustand for global state: auth identity (**never** the token), sidebar state, app-wide preferences. next-themes owns
  the theme, not Zustand.
- `persist` with `createJSONStorage(() => localStorage)`, `partialize`, `version`, and a `reset()` action on every
  persisted store.
- `useImmer` for complex local state inside a component. Form state stays local unless distant components need it.

### Auth store

```ts
partialize: (state) => ({
  user: state.user, // { sub, username, admin } | null
  expiresAt: state.expiresAt, // ms epoch: user.exp * 1000 from the login response
}),
```

Persist nothing else: no loading flags, no errors, no token. On hydration, if `user` is missing or
`expiresAt < Date.now()`, reset the store. The cookie is the real auth source on the server. `expiresAt` only keeps
the UI from flashing a dashboard for an expired session.

```ts
// src/web/stores/auth-store.ts
export const whenAuthHydrated = (): Promise<void> =>
  new Promise((resolve) => {
    if (useAuthStore.persist.hasHydrated()) return resolve();
    const unsub = useAuthStore.persist.onFinishHydration(() => {
      unsub();
      resolve();
    });
  });
```

No polling, `setInterval` or `setTimeout` retries.

### Multi-tab behavior

The auth store listens for the `storage` event. When another tab clears `user`, this tab redirects to `/login`.
When another tab sets `user`, this tab updates and shows the session. No page refresh is needed.

## Routing and route protection

- TanStack Router with file routes in `src/web/routes/` and browser history. Use typed `Link`, `useNavigate` and
  typed params everywhere, with no hand-written path strings.
- Protected pages live under a pathless layout route, `src/web/routes/_app.tsx`. Its `beforeLoad` awaits
  `whenAuthHydrated()`, then calls `redirect({ to: "/login" })` when the store has no valid user. Its
  `pendingComponent` is a stable skeleton. With no SSR, `beforeLoad` runs only in the browser, so it's the right place
  for this check.
- `/login` redirects to the dashboard when a valid user is already in the store.
- The server enforces auth independently on `/api/*` (the middleware above). Never base server auth on Zustand or
  `localStorage`.
- Page data comes from route `loader`s that call `api-client`. URL search state (filters, sort, page, query) goes
  through `validateSearch` and `useSearch`, with plain TypeScript checks. A value lives either in the URL or in
  Zustand, never in both: the URL owns shareable, page-scoped state, and Zustand owns persisted cross-page
  preferences.
- The app is served at the root of its own hostname: `<name>.localhost:8080` in selfhost dev, `hosts.json` or a
  subdomain in selfhost prod, and its own domain on Cloudflare. Path routing (`localhost:8080/<name>/`) isn't
  supported, because the SPA uses absolute `/api` and `/assets` URLs and a `Path=/` cookie.

## API client

`src/web/lib/api-client.ts` is the only way the browser calls the server:

```ts
import { hc } from "hono/client";
import type { AppType } from "../../server/app";
import { router } from "../router";
import { useAuthStore } from "../stores/auth-store";

export const api = hc<AppType>("/", {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, { ...init, credentials: "include" });
    if (res.status === 401) {
      useAuthStore.getState().reset();
      router.navigate({ to: "/login" });
    }
    return res;
  },
});
```

- The client never reads a token from Zustand or attaches one. The browser sends the cookie regardless of store state,
  so there's no hydration race.
- Call it as `api.api.notes.$get()` or `api.api.notes.$post({ json })`, then `await res.json()`. Inputs and outputs
  are typed from the server routes.
- Server code never imports `api-client.ts`.

## Theme

next-themes `ThemeProvider` with `attribute="class"` and `defaultTheme="system"` in `main.tsx`. The theme toggle
renders a placeholder until it's mounted.

## Toasts

sonner, installed with `bunx shadcn@latest add sonner`. Mount `<Toaster />` once in `__root.tsx`, and trigger it
with `import { toast } from "sonner"`.

## Forms

shadcn `form` with `react-hook-form` and its built-in validators, or plain TypeScript checks. No Zod in `src/web`.
The server validates every input again with Zod, so the client's checks are only for UX.

## Deployment

### `cloudflare`

`cloudflare.config.ts` (run `cf init .` once, then edit it to this shape; the format is a `cf` 1.0 release
candidate, so check it against `cf` docs when something doesn't match):

```ts
import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/server/entry.ts" with { type: "cf-worker" };

export default defineConfig(({ mode }) => ({
  worker: {
    name: mode === "production" ? "<name>" : "<name>-dev",
    entrypoint,
    compatibilityDate: "2026-11-01",
    assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] },
    env: {
      DB: bindings.d1({ name: mode === "production" ? "<name>-prod" : "<name>-dev" }),
      FILES: bindings.r2({ name: mode === "production" ? "<name>-files-prod" : "<name>-files-dev" }),
      JWT_SECRET: bindings.secret(),
      APP_SECRET: bindings.secret(),
      ADMIN_USERNAME: bindings.secret(),
      ADMIN_PASSWORD: bindings.secret(),
    },
  },
}));
```

- `src/server/entry.ts` is `export default app`. Static assets come from Vite's client build. `runWorkerFirst`
  sends only `/api/*` to the Worker.
- Dev: `cf dev`, with local D1 and R2 and secrets from `.dev.vars` (written by `manage.py`).
- Prod: `bun run db:apply` against the prod D1, then `cf deploy --mode production --secrets-file .secrets.prod.env`.
  `manage.py` writes `.secrets.prod.env` and deletes it afterwards.
- Find any other `cf` command with `cf cli search "<task>"`. Don't translate Wrangler commands from memory, and don't
  add a Wrangler config file.

### `selfhost`

The project becomes one app in this repo's gateway. Link it with `ln -s <project> <gateway>/apps/<name>`, where
`<name>` is a DNS label (README → App folder format).

```capnp
# worker.capnp
using Workerd = import "/workerd/workerd.capnp";

const worker :Workerd.Worker = (
  modules = [ (name = "worker", esModule = embed "dist/worker.js") ],
  compatibilityDate = "2026-11-01",
  globalOutbound = "net",   # reach sqld and RustFS on loopback
  bindings = [
    (name = "JWT_SECRET", fromEnvironment = "<PREFIX>_JWT_SECRET"),
    (name = "APP_SECRET", fromEnvironment = "<PREFIX>_APP_SECRET"),
    (name = "ADMIN_USERNAME", fromEnvironment = "<PREFIX>_ADMIN_USERNAME"),
    (name = "ADMIN_PASSWORD", fromEnvironment = "<PREFIX>_ADMIN_PASSWORD"),
    (name = "LIBSQL_URL", fromEnvironment = "<PREFIX>_LIBSQL_URL"),
    (name = "LIBSQL_AUTH_TOKEN", fromEnvironment = "<PREFIX>_LIBSQL_AUTH_TOKEN"),
    (name = "S3_ENDPOINT", fromEnvironment = "<PREFIX>_S3_ENDPOINT"),
    (name = "S3_BUCKET", fromEnvironment = "<PREFIX>_S3_BUCKET"),
    (name = "S3_ACCESS_KEY_ID", fromEnvironment = "<PREFIX>_S3_ACCESS_KEY_ID"),
    (name = "S3_SECRET_ACCESS_KEY", fromEnvironment = "<PREFIX>_S3_SECRET_ACCESS_KEY"),
  ],
);
```

`<PREFIX>` is the app name in upper case, with `-` replaced by `_`. All apps share one workerd process environment,
so the prefix keeps them apart. Never put a secret in a `text = "..."` binding.

- `bun run build`: `vite build` (writes `dist/web`), then `bun scripts/build-worker.ts`. That script bundles
  `src/server/entry.ts` with every `dist/web` file embedded, into `dist/worker.js`. `entry.ts` mounts the API app and
  then a fallback that serves embedded assets: `index.html` for unknown paths without an extension, and immutable
  cache headers for `/assets/*`. Copy the approach from `apps/access-control/scripts/build-worker.ts` and
  `src/server/index.ts` in this repo.
- Dev: run sqld for dev only (`sqld --db-path data/sqld-dev --http-listen-addr 127.0.0.1:8081`). Port 8080 belongs
  to the gateway. Then `manage.py run app dev`: it builds the Worker, starts the gateway with the prefixed variables in
  its environment, and starts `vite dev`. That serves the SPA with HMR and proxies `/api` to
  `http://<name>.localhost:8080` (`changeOrigin: true`, so the gateway routes by host). Server changes need
  `bun run build` and a gateway restart.
- Prod: secrets live in Infisical under the prefixed names (README → Environment variables and secrets). Prod
  `LIBSQL_URL` points at a different sqld database than dev. Deploying is `manage.py run app prod`.
- Several gateway instances behind a load balancer are fine: all state is in libSQL and S3.

## Environment profiles (`manage.py`)

A root-level `manage.py` (Python 3, standard library only, executable) is the only approved way to build and run the
app. It renders environment files from `template.env` and the selected profile in `config.json`. It also refuses
combinations that could touch prod data from dev.

```bash
./manage.py build app dev
./manage.py build app prod
./manage.py run app dev
./manage.py run app prod
```

### Files

```text
/manage.py
/config.example.json     committed: the shape, with placeholder values
/config.json             gitignored: real values
/template.env            committed: placeholders
/.env                    generated, gitignored (tooling: TARGET, database settings)
/.dev.vars               generated, gitignored (cloudflare dev: Worker secrets for cf dev)
/.secrets.prod.env       generated briefly for cf deploy, deleted afterwards, gitignored
```

`.gitignore` must include `.env`, `.dev.vars`, `.secrets.*`, `config.json`, `dist`, `node_modules` and `data`.

### `config.example.json`

```json
{
  "target": "cloudflare",
  "name": "myapp",
  "profiles": {
    "dev": {
      "d1DatabaseId": "<dev database id>",
      "libsqlUrl": "http://127.0.0.1:8081",
      "libsqlAuthToken": "",
      "jwtSecret": "dev-jwt-secret-at-least-32-characters-long",
      "appSecret": "dev-app-secret-at-least-32-characters-long",
      "adminUsername": "admin",
      "adminPassword": "admin"
    },
    "prod": {
      "d1DatabaseId": "<prod database id>",
      "libsqlUrl": "<prod sqld url>",
      "jwtSecret": "<32+ random characters>",
      "appSecret": "<32+ random characters>",
      "adminUsername": "<not admin>",
      "adminPassword": "<strong password>"
    }
  },
  "selfhost": { "gatewayDir": "/opt/workerd-gateway", "infisicalEnv": "prod" }
}
```

On selfhost, prod secrets come from Infisical, so the `prod` profile holds only what `db:apply` needs locally (or
nothing, when `manage.py` wraps the command in `infisical run`).

### `template.env`

```env
TARGET=#{target}
PROFILE=#{profile}
D1_DATABASE_ID=#{d1DatabaseId}
LIBSQL_URL=#{libsqlUrl}
LIBSQL_AUTH_TOKEN=#{libsqlAuthToken}
JWT_SECRET=#{jwtSecret}
APP_SECRET=#{appSecret}
ADMIN_USERNAME=#{adminUsername}
ADMIN_PASSWORD=#{adminPassword}
```

Remove the lines that don't apply to your target.

### Placeholder rules

- Replace every `#{key}`. Keys come from the selected profile, plus `target`, `name` and `profile` (the profile's
  own name).
- Throw an error naming the key and profile when a key is missing, and an error when the profile doesn't exist.
- Keep line formatting and comments unchanged.

### Commands

| Command | `cloudflare` | `selfhost` |
|---|---|---|
| `build app <p>` | render `.env`, `bun run verify`, `cf build --mode <development\|production>` | render `.env`, `bun run verify`, `bun run build` |
| `run app dev` | render `.env` and `.dev.vars`, `bun run db:apply` (local D1), `cf dev` | render `.env`, `bun run db:apply`, `bun run build`, start the gateway (`bun run dev` in `gatewayDir`) with `<PREFIX>_*` added to its environment, plus `vite dev`; Ctrl-C stops both |
| `run app prod` | `bun run verify`, `bun run db:apply` (remote D1), render `.secrets.prod.env`, `cf deploy --mode production --secrets-file .secrets.prod.env`, delete the secrets file | `bun run verify`, `bun run build`, `infisical run --env=<infisicalEnv> -- bun run db:apply`, then in `gatewayDir`: `bun gen.ts` and `sudo systemctl restart workerd-gateway` |

### Safety checks (fail fast, before anything runs)

- The dev and prod profiles point at different databases: `d1DatabaseId` differs, or `libsqlUrl` differs. If they're
  the same, stop.
- For `prod`: `adminPassword` isn't `admin` or empty, and `jwtSecret` and `appSecret` are at least 32 characters and
  differ from dev's.
- Print the target and profile before running, for example:

```text
[manage.py] Target: cloudflare  Profile: dev
[manage.py] Generated .env, .dev.vars
[manage.py] Running: bun run db:apply
[manage.py] Running: cf dev
```

Use `subprocess.run(..., check=True)` for each step, and `subprocess.Popen` only for the two long-running
selfhost dev processes. Don't rely on hand-edited `.env` files, `.env.local`, shell-exported variables or ad-hoc
switching: profiles are selected through `manage.py` only.

## Verification

`package.json` scripts:

```json
{
  "scripts": {
    "typecheck": "bun check --project tsconfig.server.json && bun check --project tsconfig.web.json",
    "check:boundaries": "bun scripts/check-boundaries.ts",
    "db:generate": "drizzle-kit generate",
    "db:check": "bun scripts/check-migrations.ts",
    "db:apply": "bun scripts/db-apply.ts",
    "test": "bun test",
    "build": "vite build && bun scripts/build-worker.ts",
    "verify": "bun run typecheck && bun run check:boundaries && bun run db:check && bun run test && bun run build"
  }
}
```

The cloudflare target's `build` is `vite build` alone, because `cf build` bundles the Worker. `verify` also fails when
`db.delete(` appears in `src/server/routes` or `src/server/repositories`.

Tests (`bun test`) cover the server logic that doesn't need a database: `lib/auth.ts` (sign, verify, expiry),
`lib/password.ts`, `env.ts`, and the auth middleware's transport order. For the middleware, call
`app.request(...)` with a stub `db`. Every rule in [Order of checks](#order-of-checks) has a test, including both
no-fallback cases.

## Implementation rules

- Inspect before editing. Make small, reviewable changes.
- Don't create duplicate components, stores, schemas or routes. Reuse the existing layout, sidebar and patterns.
- Keep code typed. Avoid `any` unless it can't be avoided, and say why in a comment.
- Run `bun run verify` after each meaningful change, and fix every error before moving on.
- Don't claim completion unless `bun run verify` passes, or report exactly what still fails.

## Deliverable

At the end, summarize:

- the target (`cloudflare` or `selfhost`)
- files changed
- features implemented
- tables added (additive only: confirm `bun run db:check` passed, `commonColumns` and `users` exist, and every table
  indexes `deletedAt`)
- commands run
- `bun run verify` result
- remaining issues, if any
