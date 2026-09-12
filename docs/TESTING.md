# Testing Light

## Quality commands

Run the complete local verification from the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Optional lint verification:

```sh
npm run lint
```

All checks are local and require no provider credentials, model integration, paid service, or outbound inference request.

## Test organization

| Suite | Coverage |
| --- | --- |
| `tests/routing.test.ts` | deterministic priority, disabled routes, fallback ordering, and budget exhaustion |
| `tests/store.test.ts` | key hashing, secret redaction, persistence, CRUD, and logs |
| `tests/admin-token.test.ts` | configured and generated/persisted admin tokens |
| `tests/server.test.ts` | health, authentication, admin resources, gateway keys, request validation, model catalog, logs, budgets, and the no-provider boundary |

## Known RED/GREEN evidence

The implementation was developed against observable failing and passing states:

| Stage | RED evidence | GREEN evidence |
| --- | --- | --- |
| Routing | Routing module missing | **5 routing tests passed** after implementation |
| Store | Store module missing | **4 store tests passed** after implementation |
| Server | Server behavior required correction | **21 server tests passed** after correction |
| Full suite | — | **32 tests passed** across 4 test files |

The current 42-test total is composed of 5 routing tests, 4 store tests, 2 admin-token tests, 6 dashboard tests, and 25 server tests.

## Model-switching readiness

The dashboard suite covers the disconnected model catalog and fallback-order controls. Server integration tests verify that model placeholders and their ordered route metadata persist without adding any inference transport.

## Critical regression assertions

Tests should continue to prove that:

- every `/v1/*` route rejects missing or invalid gateway bearer keys;
- every `/admin/*` route uses the distinct admin token boundary;
- gateway key hashes and secret-shaped log fields are never exposed;
- provider metadata rejects credential fields;
- exhausted budgets return a structured `429` locally;
- absent aliases return a structured `404` locally;
- configured aliases return `503 provider_not_connected`;
- chat requests make **zero network calls**, even when routes and provider metadata exist.

The final assertion is the release's most important scope guard: Light currently manages local metadata but has no provider/model integration and no outbound call path.
