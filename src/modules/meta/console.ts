import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Developer test console (static files). Disabled when NODE_ENV=production. */
const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../public');
const FILES: Record<string, [string, string]> = {
  '/': ['console.html', 'text/html; charset=utf-8'],
  '/console.js': ['console.js', 'text/javascript; charset=utf-8'],
  '/console.css': ['console.css', 'text/css; charset=utf-8'],
};
export default async function consoleRoutes(app: FastifyInstance) {
  if (process.env.NODE_ENV === 'production') return;
  for (const [url, [file, type]] of Object.entries(FILES)) {
    app.get(url, { config: { public: true } }, async (_req, reply) => reply.type(type).send(readFileSync(join(DIR, file))));
  }
}
