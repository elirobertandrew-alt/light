import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { RelayStore } from '../src/store.js';

let store: RelayStore;
let app: ReturnType<typeof buildServer>;
const ADMIN = 'test-admin-token';
const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const admin = { 'x-admin-token': ADMIN };

beforeEach(() => {
  store = new RelayStore(':memory:');
  app = buildServer({ store, adminToken: ADMIN });
});
afterEach(async () => { await app.close(); store.close(); vi.unstubAllGlobals(); });

describe('health and authentication', () => {
  it('serves an unauthenticated health check', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it.each([
    ['GET', '/v1/models', undefined],
    ['POST', '/v1/chat/completions', { model: 'writer', messages: [{ role: 'user', content: 'hi' }] }],
  ])('requires a valid bearer key for %s %s', async (method, url, payload) => {
    expect((await app.inject({ method: method as 'GET' | 'POST', url, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: method as 'GET' | 'POST', url, headers: auth('rf_bogus'), payload })).statusCode).toBe(401);
  });

  it('protects every admin route with a distinct admin token', async () => {
    const { key } = store.createKey('gateway');
    for (const url of ['/admin/providers', '/admin/models', '/admin/routes', '/admin/limits', '/admin/keys', '/admin/logs']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url, headers: { 'x-admin-token': 'wrong' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url, headers: auth(key) })).statusCode).toBe(401);
    }
  });
});

describe('admin resources', () => {
  it.each(['providers', 'models', 'routes', 'limits'])('supports CRUD for %s', async (collection) => {
    const created = await app.inject({ method: 'POST', url: `/admin/${collection}`, headers: admin, payload: { name: 'first', enabled: true } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await app.inject({ method: 'GET', url: `/admin/${collection}`, headers: admin })).json()).toHaveLength(1);
    const updated = await app.inject({ method: 'PUT', url: `/admin/${collection}/${id}`, headers: admin, payload: { name: 'second' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().name).toBe('second');
    expect((await app.inject({ method: 'DELETE', url: `/admin/${collection}/${id}`, headers: admin })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/admin/${collection}`, headers: admin })).json()).toEqual([]);
  });

  it('stores disconnected model placeholders and ordered fallback routes', async () => {
    const provider = (await app.inject({ method: 'POST', url: '/admin/providers', headers: admin, payload: { name: 'Future local provider', kind: 'local', enabled: false } })).json();
    const primary = await app.inject({ method: 'POST', url: '/admin/models', headers: admin, payload: { name: 'Primary model', providerId: provider.id, modelId: 'primary', enabled: false } });
    const fallback = await app.inject({ method: 'POST', url: '/admin/models', headers: admin, payload: { name: 'Fallback model', providerId: provider.id, modelId: 'fallback', enabled: false } });
    expect(primary.statusCode).toBe(201);
    expect(fallback.statusCode).toBe(201);

    await app.inject({ method: 'POST', url: '/admin/routes', headers: admin, payload: { alias: 'assistant', providerId: provider.id, modelId: primary.json().id, priority: 1, enabled: true } });
    await app.inject({ method: 'POST', url: '/admin/routes', headers: admin, payload: { alias: 'assistant', providerId: provider.id, modelId: fallback.json().id, priority: 2, enabled: true } });
    const routes = (await app.inject({ method: 'GET', url: '/admin/routes', headers: admin })).json();
    expect(routes.map((route: { modelId: string; priority: number }) => [route.modelId, route.priority])).toEqual([
      [primary.json().id, 1],
      [fallback.json().id, 2],
    ]);
  });

  it('rejects provider credentials instead of accepting or storing them', async () => {
    for (const field of ['apiKey', 'token', 'secret', 'password', 'authorization']) {
      const res = await app.inject({ method: 'POST', url: '/admin/providers', headers: admin, payload: { name: 'provider', [field]: 'sensitive' } });
      expect(res.statusCode).toBe(400);
    }
    expect(store.list('providers')).toEqual([]);
  });

  it.each([
    'https://user:password@example.invalid/v1',
    'https://example.invalid/v1?api_key=supersecret',
    'https://example.invalid/v1#token=supersecret',
  ])('rejects credentials embedded in provider baseUrl: %s', async (baseUrl) => {
    const res = await app.inject({ method: 'POST', url: '/admin/providers', headers: admin, payload: { name: 'provider', baseUrl } });
    expect(res.statusCode).toBe(400);
    expect(store.list('providers')).toEqual([]);
  });

  it('creates a gateway key once, lists metadata without hashes, and revokes it', async () => {
    const created = await app.inject({ method: 'POST', url: '/admin/keys', headers: admin, payload: { name: 'CI key' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().key).toMatch(/^rf_/);
    const listed = (await app.inject({ method: 'GET', url: '/admin/keys', headers: admin })).json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('hash');
    expect(JSON.stringify(listed)).not.toContain(created.json().key);
    expect((await app.inject({ method: 'DELETE', url: `/admin/keys/${created.json().id}`, headers: admin })).statusCode).toBe(204);
    expect(store.verifyKey(created.json().key)).toBe(false);
  });
});

describe('model catalog and no-provider chat boundary', () => {
  it('lists distinct enabled route aliases as OpenAI-compatible models', async () => {
    const { key } = store.createKey('client');
    store.create('routes', { alias: 'writer', enabled: true, priority: 2, providerId: 'metadata-only' });
    store.create('routes', { alias: 'writer', enabled: true, priority: 1, providerId: 'other' });
    store.create('routes', { alias: 'disabled', enabled: false, priority: 1, providerId: 'none' });
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: auth(key) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ object: 'list', data: [{ id: 'writer', object: 'model', owned_by: 'light' }] });
  });

  it.each([
    [{ messages: [{ role: 'user', content: 'hi' }] }, 'missing model'],
    [{ model: 'writer' }, 'missing messages'],
    [{ model: 'writer', messages: [] }, 'empty messages'],
    [{ model: 'writer', messages: [{ role: 'invalid', content: 'hi' }] }, 'invalid role'],
    [{ model: 'writer', messages: [{ role: 'user' }] }, 'missing content'],
    [{ model: 'writer', messages: [{ role: 'user', content: 'hi' }], stream: 'yes' }, 'invalid stream'],
  ])('validates OpenAI-ish requests: %s (%s)', async (payload, _label) => {
    const { key } = store.createKey('client');
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth(key), payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
  });

  it('returns a structured 404 and logs a redacted attempt for an absent alias', async () => {
    const { key } = store.createKey('client');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth(key), payload: { model: 'ghost', messages: [{ role: 'user', content: 'rf_supersecret' }] } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { type: 'invalid_request_error', code: 'model_not_found' } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.listLogs()[0].request).not.toContain('rf_supersecret');
  });

  it('returns a structured 503 for a configured alias and performs zero network calls', async () => {
    const { key } = store.createKey('client');
    store.create('routes', { alias: 'writer', enabled: true, priority: 1, providerId: 'metadata-only' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth(key), payload: { model: 'writer', messages: [{ role: 'user', content: 'hi' }], stream: true } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { type: 'server_error', code: 'provider_not_connected' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a structured 429 when the alias budget is exhausted without network access', async () => {
    const { key } = store.createKey('client');
    store.create('routes', { alias: 'writer', enabled: true, priority: 1, providerId: 'metadata-only' });
    store.create('limits', { alias: 'writer', requestLimit: 1, requestsUsed: 1 });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth(key), payload: { model: 'writer', messages: [{ role: 'user', content: 'hi' }] } });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { type: 'rate_limit_error', code: 'budget_exceeded' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exposes logged attempts through protected log list/detail routes', async () => {
    const { key } = store.createKey('client');
    await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth(key), payload: { model: 'ghost', messages: [{ role: 'user', content: 'hi' }] } });
    const list = (await app.inject({ method: 'GET', url: '/admin/logs', headers: admin })).json();
    expect(list).toHaveLength(1);
    const detail = await app.inject({ method: 'GET', url: `/admin/logs/${list[0].id}`, headers: admin });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().status).toBe(404);
  });
});
