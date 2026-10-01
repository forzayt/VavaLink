/**
 * Attaches a request id to every request/response pair and logs the outcome.
 *
 * The id comes from `X-Request-Id` when a client supplies one, which makes
 * tracing across a future load balancer possible.
 */

import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { Logger } from '../lib/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlation id for this request. */
    id: string;
  }
}

const REQUEST_ID_HEADER = 'x-request-id';

export function createRequestLogger(logger: Logger): RequestHandler {
  const log = logger.child({ component: 'http' });

  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const id = incoming !== undefined && incoming.length > 0 && incoming.length <= 128 ? incoming : randomUUID();

    req.id = id;
    res.setHeader('X-Request-Id', id);

    const startedAt = performance.now();
    // Captured up front: mounted routers rewrite `req.url` while dispatching.
    const method = req.method;
    const path = req.originalUrl;

    res.on('finish', () => {
      const durationMs = Math.round(performance.now() - startedAt);
      const fields = {
        id,
        method,
        path,
        status: res.statusCode,
        durationMs,
      };

      if (res.statusCode >= 500) log.error('request failed', fields);
      else if (res.statusCode >= 400) log.warn('request rejected', fields);
      else log.info('request completed', fields);
    });

    res.on('close', () => {
      // `finish` never fires when the client disconnects mid-response.
      if (!res.writableFinished) {
        log.warn('client disconnected', {
          id,
          method,
          path,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
    });

    next();
  };
}