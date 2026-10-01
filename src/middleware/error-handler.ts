/**
 * Terminal error handling.
 *
 * Contract: one JSON body, one status code, never a stack trace. Once headers
 * are on the wire we can no longer negotiate an error response, so we destroy
 * the socket instead - a truncated body is the honest signal.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';

import { MalformedJsonError, RouteNotFoundError, toVavaLinkError, VavaLinkError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

export interface ErrorHandlerOptions {
  readonly logger: Logger;
  /** Include stack traces for 5xx responses (development only). */
  readonly includeStacks: boolean;
}

export function createErrorHandler(options: ErrorHandlerOptions): ErrorRequestHandler {
  const logger = options.logger.child({ component: 'http' });

  return (error, req, res, next): void => {
    const typed = normalise(error);

    if (typed.code === 'CLIENT_ABORTED') {
      // The client is gone; nothing to respond to and nothing to alarm anyone.
      logger.debug('client aborted request', { id: req.id, path: req.path });
      if (!res.headersSent) res.status(typed.status).end();
      return;
    }

    if (res.headersSent) {
      logger.warn('error after headers were sent, destroying response', {
        id: req.id,
        path: req.path,
        code: typed.code,
        reason: typed.message,
      });
      res.destroy();
      return;
    }

    const level = typed.status >= 500 ? 'error' : 'warn';
    logger[level]('request errored', {
      id: req.id,
      path: req.path,
      code: typed.code,
      status: typed.status,
      reason: typed.message,
      ...(typed.cause ? { cause: describe(typed.cause) } : {}),
    });

    if (!res.writableEnded) {
      res.status(typed.status).json({
        ...typed.toJSON(),
        requestId: req.id,
        ...(options.includeStacks && typed.status >= 500 && typed.stack ? { stack: typed.stack } : {}),
      });
    }

    next();
  };
}

/** Unknown routes: answer with the same JSON shape as everything else. */
export function createNotFoundHandler(logger: Logger): RequestHandler {
  const log = logger.child({ component: 'http' });

  return (req, _res, next): void => {
    log.debug('no route matched', { id: req.id, method: req.method, path: req.path });
    next(new RouteNotFoundError(req.method, req.originalUrl));
  };
}

/** Map anything thrown anywhere into a `VavaLinkError`. */
function normalise(error: unknown): VavaLinkError {
  if (isBodyParserError(error)) {
    return new MalformedJsonError(error);
  }

  if (error instanceof VavaLinkError) {
    return error;
  }

  const converted = toVavaLinkError(error);

  // Node/Express internal errors we can still talk about.
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ETIMEDOUT') {
    return new VavaLinkError('TIMEOUT', 'Request timed out', 504, { cause: error });
  }

  return converted;
}

/** `express.json()` rejects malformed bodies with a `SyntaxError`. */
function isBodyParserError(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false;
  const type = (error as { type?: string }).type;
  return type === 'entity.parse.failed' || 'body' in error;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}