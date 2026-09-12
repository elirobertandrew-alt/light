# Light

Light is a fully free, local-first control plane for an OpenAI-compatible gateway. It stores provider, model, route, limit, key, and request-log metadata in a local SQLite database and exposes authenticated administration and gateway APIs.

> **Current scope:** Light has no provider or model integrations and makes no outbound inference calls. Provider records are metadata only. A valid chat request for a configured alias stops at the local boundary with `provider_not_connected` (`503`).

## Requirements

- Node.js 22 or newer
- npm

No paid service, hosted account, API key, or external model provider is required.

## Local development

```sh
npm ci
npm run dev
```

The server listens on `http://127.0.0.1:8787` by default. Development mode watches `src/server-main.ts`.

On first start, Light creates:

- `data/light.db` — local SQLite data
- `data/admin-token.txt` — generated admin token when `LIGHT_ADMIN_TOKEN` is unset

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address. Use `0.0.0.0` in a container. |
| `PORT` | `8787` | HTTP port. |
| `LIGHT_DB` | `data/light.db` | SQLite database path. |
| `LIGHT_ADMIN_TOKEN` | unset | Optional admin token supplied directly. |
| `LIGHT_ADMIN_TOKEN_FILE` | `data/admin-token.txt` | Generated/persisted token file. |

Keep the `data/` directory private and persistent. Do not commit its database or admin token.

## Commands

```sh
npm run typecheck       # TypeScript validation
npm test                # 32-test Vitest suite
npm run lint            # ESLint flat-config checks
npm run build           # Vite client build + server TypeScript build
npm start               # Run dist-server/server-main.js
```

## API boundaries

- `GET /healthz` is unauthenticated.
- `/v1/*` requires a Light gateway key as a bearer token.
- `/admin/*` requires `x-admin-token`.
- Gateway keys are salted and hashed; plaintext is returned only when a key is created.
- Stored request/response logs redact credential-shaped fields and bearer/key values.
- Provider metadata rejects credential fields rather than storing them.

## Docker

```sh
docker compose up --build
```

The Compose service binds Light to `127.0.0.1:8787` on the host and persists data in the `light-data` volume. To expose it beyond the local machine, deliberately change the host binding and place it behind appropriate TLS and access controls.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Testing](docs/TESTING.md)

## License

MIT © 2026 Elijah Robert Andrew. See [LICENSE](LICENSE).
