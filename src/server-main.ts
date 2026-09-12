import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { RelayStore } from './store.js';
import { buildServer } from './server.js';
import { resolveAdminToken } from './admin-token.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.LIGHT_DB ?? 'data/light.db';
const tokenFile = process.env.LIGHT_ADMIN_TOKEN_FILE ?? 'data/admin-token.txt';
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

const store = new RelayStore(dbPath);
const adminToken = resolveAdminToken({ env: process.env.LIGHT_ADMIN_TOKEN, tokenFile });

const app = buildServer({ store, adminToken });

const webDist = join(__dirname, '..', 'dist');
app.register(fastifyStatic, { root: webDist, wildcard: false });
app.setNotFoundHandler(async (req, reply) => {
  if (req.raw.method === 'GET' && !req.url.startsWith('/v1/') && !req.url.startsWith('/admin/')) {
    return reply.sendFile('index.html');
  }
  return reply.code(404).send({ error: 'not found' });
});

app.listen({ port, host }).then(() => {
  console.log(`Light listening on http://${host}:${port}`);
  console.log(`Admin token file: ${tokenFile} (also honors LIGHT_ADMIN_TOKEN env var)`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
