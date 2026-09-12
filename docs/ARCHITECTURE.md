# Light Architecture

## Purpose and scope

Light is a fully free, local-first control plane for an OpenAI-compatible gateway surface. It manages local metadata, access keys, budgets, deterministic route selection, and redacted request logs.

The current release intentionally has **no provider or model integrations and performs no outbound calls**. Provider and model records are metadata only. A configured chat request reaches a deliberate local `503 provider_not_connected` boundary rather than contacting a remote or local inference provider.

## Runtime

```text
Client
  |
  v
Fastify application
  |-- GET /healthz                  (public health check)
  |-- /v1/*                         (gateway bearer key)
  |-- /admin/*                      (admin token)
  |-- static assets / SPA fallback  (dist/)
  |
  v
RelayStore
  |
  v
SQLite (data/light.db by default)
```

`src/server-main.ts` is the executable entry point. It resolves paths and environment configuration, opens `RelayStore`, resolves the admin token, builds the Fastify server, serves the Vite build, and listens on `HOST`/`PORT`.

`src/server.ts` defines the HTTP contract and authentication boundaries. `src/routing.ts` resolves local route metadata. `src/store.ts` owns SQLite persistence, key hashing, CRUD, logging, and redaction. `src/admin-token.ts` resolves or creates the local administration secret.

## Data and routing

SQLite stores four metadata collections: providers, models, routes, and limits. Separate tables contain hashed gateway keys and redacted request logs. The default database and generated admin token are under `data/`, which must remain private and persistent.

Routing is deterministic: enabled candidates for the requested alias are sorted by ascending priority and then stable route ID. Exhausted request or USD budgets block routing. Candidate resolution never invokes a provider in this release.

The dashboard exposes this future failover design directly. Operators can create disconnected model placeholders, assign them to a shared alias, and arrange the route priority order. Priority `1` is attempted first; later entries are intended as automatic fallbacks when a future adapter reports exhausted usage or another retryable availability failure. Until adapters are explicitly connected, these records remain inert metadata and every otherwise-valid inference request stops at `503 provider_not_connected`.

## Security boundaries

- `/v1/*` requires a valid Light bearer key.
- `/admin/*` requires the distinct `x-admin-token` value.
- Gateway keys are salted and hashed; plaintext is revealed only at creation.
- Logs recursively redact credential-shaped fields, bearer values, and Light keys.
- Provider metadata rejects credentials instead of persisting them.
- CORS cross-origin access is disabled; Helmet supplies response security headers.
- The server defaults to loopback-only access outside the container configuration.

These safeguards do not replace TLS or network access controls when an operator deliberately exposes Light beyond localhost.

## Build and deployment

`npm run build` produces:

- `dist/` from Vite for static web assets;
- `dist-server/` from the server TypeScript configuration.

`npm start` executes `dist-server/server-main.js`. The Docker image uses a multi-stage Node 22 build, runs as the unprivileged `node` user, and keeps `/app/data` on a persistent volume. Docker Compose publishes the service on host loopback by default.

## External connectivity

Light itself has no runtime telemetry, hosted control plane, provider SDK, model adapter, or inference egress. Package installation and image building may access configured npm/container registries, but running Light does not require a paid service or provider credential and its application paths make no outbound calls.
