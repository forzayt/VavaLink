/**
 * Express application assembly.
 *
 * `createApp` returns a fully wired app with no listening side effects, which
 * keeps it usable from tests and from a future clustered entrypoint.
 */

import express, { type Application, type NextFunction, type Request, type Response } from 'express';

import type { AppContext } from './context.js';
import { createAudioRouter } from './routes/audio.js';
import { createHealthRouter, createRootRouter } from './routes/health.js';
import { createErrorHandler, createNotFoundHandler } from './middleware/error-handler.js';
import { createRequestLogger } from './middleware/request-logger.js';

export interface CreateAppOptions {
  readonly context: AppContext;
}

export function createApp(options: CreateAppOptions): Application {
  const { context } = options;
  const { config } = context;

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(createRequestLogger(context.logger));
  app.use(corsMiddleware(config.server.corsOrigin));
  app.use(express.json({ limit: config.server.jsonBodyLimit }));

  // A malformed JSON body should reach the error handler as a typed error.
  app.use((error: unknown, _req: Request, _res: Response, next: NextFunction): void => {
    if (error) next(error);
    else next();
  });

  app.use(createRootRouter(context));
  app.use(createHealthRouter(context));
  app.use('/v1', createAudioRouter(context));

  app.use(createNotFoundHandler(context.logger));
  app.use(
    createErrorHandler({
      logger: context.logger,
      includeStacks: config.env === 'development',
    }),
  );

  return app;
}

/**
 * Minimal CORS. Phase 1 has no auth, so this only exists to keep a browser
 * dashboard workable later; it is replaced by a real policy when tokens arrive.
 */
function corsMiddleware(allowed: readonly string[] | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('origin');
    if (origin !== undefined && (allowed === null || allowed.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowed === null ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Request-Id');
      res.setHeader('Access-Control-Max-Age', '600');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}