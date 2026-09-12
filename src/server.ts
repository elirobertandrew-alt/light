import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { RelayStore, type Collection, type Row } from './store.js';
import { resolveRoute, type Budget, type RouteCandidate } from './routing.js';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.unknown())]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
}).passthrough();
const chatSchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional().default(false),
}).passthrough();
const objectSchema = z.record(z.unknown());
const providerSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
}).strict();
const keySchema = z.object({ name: z.string().min(1) }).strict();
const sensitiveProviderFields = /^(api[-_]?key|authorization|token|secret|password|cookie)$/i;

type ErrorType = 'invalid_request_error' | 'rate_limit_error' | 'server_error';
function openAiError(message: string, type: ErrorType, code: string, param: string | null = null) {
  return { error: { message, type, param, code } };
}
function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function publicKey(row: Row) {
  const { hash: _hash, ...metadata } = row;
  return metadata;
}
function bodyRecord(body: unknown): Record<string, unknown> | null {
  const parsed = objectSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
function providerBody(body: unknown) {
  const record = bodyRecord(body);
  if (!record || Object.keys(record).some((key) => sensitiveProviderFields.test(key))) return null;
  const parsed = providerSchema.safeParse(record);
  if (parsed.success && parsed.data.baseUrl) {
    const url = new URL(parsed.data.baseUrl);
    const hasSensitiveParameter = [...url.searchParams.keys()].some((key) => sensitiveProviderFields.test(key));
    const hasSensitiveFragment = url.hash.length > 1 && sensitiveProviderFields.test(url.hash.slice(1).split('=', 1)[0]);
    if (url.username || url.password || hasSensitiveParameter || hasSensitiveFragment) return null;
  }
  return parsed.success ? parsed.data : null;
}

export interface BuildOptions {
  store: RelayStore;
  adminToken?: string;
}

export function buildServer({ store, adminToken }: BuildOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(helmet, { contentSecurityPolicy: false });
  void app.register(cors, { origin: false });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/v1/')) {
      const authorization = request.headers.authorization;
      const match = typeof authorization === 'string' && /^Bearer\s+(\S+)$/.exec(authorization);
      if (!match || !store.verifyKey(match[1])) {
        return reply.code(401).send(openAiError('Invalid or missing bearer token.', 'invalid_request_error', 'invalid_api_key'));
      }
    }
    if (request.url.startsWith('/admin/')) {
      const supplied = request.headers['x-admin-token'];
      if (typeof supplied !== 'string') return reply.code(401).send({ error: 'Missing x-admin-token header.' });
      if (!adminToken || !safeEqual(supplied, adminToken)) return reply.code(403).send({ error: 'Invalid admin token.' });
    }
  });

  app.get('/v1/models', async () => {
    const aliases = [...new Set(store.list('routes')
      .filter((route) => route.enabled === true && typeof route.alias === 'string')
      .map((route) => route.alias as string))].sort();
    return { object: 'list', data: aliases.map((id) => ({ id, object: 'model', owned_by: 'light' })) };
  });

  function sendLoggedError(reply: FastifyReply, status: number, model: string, stream: boolean, request: unknown, error: ReturnType<typeof openAiError>) {
    store.recordLog({ status, model, stream, request, response: error });
    return reply.code(status).send(error);
  }

  app.post('/v1/chat/completions', async (request, reply) => {
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(openAiError('Invalid chat completion request.', 'invalid_request_error', 'invalid_request'));
    }

    const { model, stream } = parsed.data;
    const routes = store.list('routes').filter((route) => route.alias === model);
    if (routes.length === 0) {
      return sendLoggedError(reply, 404, model, stream, parsed.data,
        openAiError(`The model alias '${model}' does not exist.`, 'invalid_request_error', 'model_not_found', 'model'));
    }

    const limit = store.list('limits').find((row) => row.alias === model || row.id === model);
    const budget: Budget = {
      requestLimit: limit?.requestLimit as number | null | undefined,
      requestsUsed: limit?.requestsUsed as number | undefined,
      usdLimit: limit?.usdLimit as number | null | undefined,
      usdUsed: limit?.usdUsed as number | undefined,
    };
    const candidates = resolveRoute(model, routes as unknown as RouteCandidate[], budget);
    const budgetBlocked =
      (budget.requestLimit != null && (budget.requestsUsed ?? 0) >= budget.requestLimit) ||
      (budget.usdLimit != null && (budget.usdUsed ?? 0) >= budget.usdLimit);
    if (budgetBlocked) {
      return sendLoggedError(reply, 429, model, stream, parsed.data,
        openAiError(`Budget exhausted for model alias '${model}'.`, 'rate_limit_error', 'budget_exceeded', 'model'));
    }

    // This release intentionally has no provider integrations. Routes and providers
    // are metadata only, so even valid candidates must stop at this boundary.
    return sendLoggedError(reply, 503, model, stream, { ...parsed.data, candidateRouteIds: candidates.map((route) => route.id) },
      openAiError(`No provider integration is connected for model alias '${model}'.`, 'server_error', 'provider_not_connected'));
  });

  const collections: Collection[] = ['providers', 'models', 'routes', 'limits'];
  for (const collection of collections) {
    app.get(`/admin/${collection}`, async () => {
      const rows = store.list(collection);
      return collection === 'routes'
        ? rows.sort((left, right) => Number(left.priority ?? 0) - Number(right.priority ?? 0) || left.id.localeCompare(right.id))
        : rows;
    });
    app.post(`/admin/${collection}`, async (request, reply) => {
      const body = collection === 'providers' ? providerBody(request.body) : bodyRecord(request.body);
      if (!body) return reply.code(400).send({ error: `Invalid ${collection.slice(0, -1)} metadata.` });
      return reply.code(201).send(store.create(collection, body));
    });
    const update = async (request: { body: unknown; params: { id: string } }, reply: FastifyReply) => {
      const body = collection === 'providers' ? providerBody(request.body) : bodyRecord(request.body);
      if (!body) return reply.code(400).send({ error: `Invalid ${collection.slice(0, -1)} metadata.` });
      const row = store.update(collection, request.params.id, body);
      return row ? reply.send(row) : reply.code(404).send({ error: 'Not found.' });
    };
    app.put<{ Params: { id: string } }>(`/admin/${collection}/:id`, update);
    app.patch<{ Params: { id: string } }>(`/admin/${collection}/:id`, update);
    app.delete<{ Params: { id: string } }>(`/admin/${collection}/:id`, async (request, reply) =>
      store.remove(collection, request.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'Not found.' }));
  }

  app.get('/admin/keys', async () => store.listKeys().map(publicKey));
  app.post('/admin/keys', async (request, reply) => {
    const parsed = keySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid key request.' });
    const { hash: _hash, ...created } = store.createKey(parsed.data.name);
    return reply.code(201).send(created);
  });
  app.delete<{ Params: { id: string } }>('/admin/keys/:id', async (request, reply) =>
    store.revokeKey(request.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'Not found.' }));

  app.get('/admin/logs', async () => store.listLogs());
  app.get<{ Params: { id: string } }>('/admin/logs/:id', async (request, reply) => {
    const log = store.getLog(request.params.id);
    return log ? reply.send(log) : reply.code(404).send({ error: 'Not found.' });
  });

  return app;
}

if (process.env.NODE_ENV !== 'test' && process.argv[1]?.endsWith('/server.js')) {
  const store = new RelayStore();
  const server = buildServer({ store, adminToken: process.env.LIGHT_ADMIN_TOKEN });
  server.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' })
    .catch((error) => { server.log.error(error); process.exit(1); });
}
