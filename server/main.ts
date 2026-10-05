/**
 * Bifurcation Engine v14 server entry
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
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

// API routes first
app.use(routes);

async function start() {
  if (NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: ROOT,
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(vite.middlewares);
    app.use(async (req, res, next) => {
      try {
        const url = req.originalUrl;
        const template = await fs.promises.readFile(path.join(ROOT, 'index.html'), 'utf-8');
        const html = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    const dist = path.join(ROOT, 'dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      throw new Error(
        'dist/index.html not found. Run "npm run build" before start, or use start script that builds first.',
      );
    }
    app.use(express.static(dist));
    // SPA fallback only for non-API GET
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(
      JSON.stringify({
        type: 'boot',
        version: '14.0.0',
        port: PORT,
        env: NODE_ENV,
        hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
        testerCodes: (process.env.TESTER_CODES || '').split(',').filter(Boolean).length,
      }),
    );
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
