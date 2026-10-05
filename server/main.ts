/**
 * Bifurcation Engine v14 server entry
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { assertAuthConfig } from './auth.ts';
import routes from './routes.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = Number(process.env.MAX_BODY_BYTES) || 256 * 1024;
const NODE_ENV = process.env.NODE_ENV || 'development';

assertAuthConfig();

const app = express();
app.use(express.json({ limit: MAX_BODY }));

// Security headers (PRV-4)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  const origin = process.env.PUBLIC_ORIGIN;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  next();
});

app.use(routes);

async function start() {
  if (NODE_ENV !== 'production') {
    const vite = await createViteServer({
      root: ROOT,
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(vite.middlewares);
    app.use('*', async (req, res, next) => {
      try {
        const url = req.originalUrl;
        let html = await vite.transformIndexHtml(url, await (await import('node:fs/promises')).readFile(path.join(ROOT, 'index.html'), 'utf-8'));
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    app.use(express.static(path.join(ROOT, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(ROOT, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(JSON.stringify({ type: 'boot', version: '14.0.0', port: PORT, env: NODE_ENV }));
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
