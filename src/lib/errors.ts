/**
 * Error taxonomy for VavaLink.
 *
 * Every failure that can reach an HTTP client is expressed as a `VavaLinkError`
 * so the error middleware can translate it into a stable JSON body without
 * guessing at status codes or leaking internals.
 */

export const ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_JSON',
  'NO_MATCHES',
  'TRACK_UNAVAILABLE',
  'SOURCE_ERROR',
  'SOURCE_UNAVAILABLE',
  'FFMPEG_UNAVAILABLE',
  'ENCODING_FAILED',
  'TIMEOUT',
  'CLIENT_ABORTED',
  'METHOD_NOT_ALLOWED',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface VavaLinkErrorOptions {
  /** Machine readable extras (never include secrets here). */
  readonly details?: Record<string, unknown>;
  /** Underlying error that triggered this one. */
  readonly cause?: unknown;
  /** Set to false to hide `message` from HTTP clients (defaults to true). */
  readonly expose?: boolean;
  /** Extra headers the error response must carry (e.g. `Allow`). */
  readonly headers?: Readonly<Record<string, string>>;
}

export class VavaLinkError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly expose: boolean;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    options: VavaLinkErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.expose = options.expose ?? true;
    this.headers = options.headers;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.expose ? this.message : 'Internal server error',
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** 400 - the request payload failed schema validation. */
export class ValidationError extends VavaLinkError {
  constructor(message: string, options: VavaLinkErrorOptions = {}) {
    super('INVALID_REQUEST', message, 400, options);
  }
}

/** 400 - the body could not be parsed as JSON. */
export class MalformedJsonError extends VavaLinkError {
  constructor(cause: unknown) {
    super('INVALID_JSON', 'Request body must be valid JSON', 400, { cause, expose: false });
  }
}

/** 404 - no source was able to match the query. */
export class NoMatchesError extends VavaLinkError {
  constructor(query: string, triedSources: readonly string[]) {
    super('NO_MATCHES', `No results found for query: ${query}`, 404, {
      details: { query, triedSources },
    });
  }
}

/** 404 - the track exists but its audio cannot be located right now. */
export class TrackUnavailableError extends VavaLinkError {
  constructor(message: string, options: VavaLinkErrorOptions = {}) {
    super('TRACK_UNAVAILABLE', message, 404, options);
  }
}

/** 502 - a source resolver or helper process failed while handling the query. */
export class SourceError extends VavaLinkError {
  constructor(message: string, options: VavaLinkErrorOptions = {}) {
    super('SOURCE_ERROR', message, 502, options);
  }
}

/** 503 - a source is configured but its dependency (binary, network) is missing. */
export class SourceUnavailableError extends VavaLinkError {
  constructor(message: string, options: VavaLinkErrorOptions = {}) {
    super('SOURCE_UNAVAILABLE', message, 503, options);
  }
}

/** 503 - the ffmpeg binary could not be spawned. */
export class FfmpegUnavailableError extends VavaLinkError {
  constructor(message: string, options: VavaLinkErrorOptions = {}) {
    super('FFMPEG_UNAVAILABLE', message, 503, options);
  }
}

/** 502 - ffmpeg started but failed or exited non-zero mid stream. */
export class EncodingError extends VavaLinkError {
  constructor(message: string, options: VavaLinkErrorOptions = {}) {
    super('ENCODING_FAILED', message, 502, options);
  }
}

/** 504 - an operation exceeded its deadline. */
export class TimeoutError extends VavaLinkError {
  constructor(message: string, options: VavaLinkErrorOptions = {}) {
    super('TIMEOUT', message, 504, options);
  }
}

/**
 * 499 - the client went away before we finished. Nginx's "client closed
 * request" convention; never retried and never surfaced as a 5xx.
 */
export class ClientAbortedError extends VavaLinkError {
  constructor(message = 'Client closed the connection', options: VavaLinkErrorOptions = {}) {
    super('CLIENT_ABORTED', message, 499, options);
  }
}

/** 404 - unknown route. */
export class RouteNotFoundError extends VavaLinkError {
  constructor(method: string, path: string) {
    super('NOT_FOUND', `Cannot ${method} ${path}`, 404);
  }
}

/**
 * 405 - the path exists but not for this method. Carries `Allow` and, in
 * `details.example`, a ready-to-paste request so clients stop guessing.
 */
export class MethodNotAllowedError extends VavaLinkError {
  constructor(method: string, path: string, allow: readonly string[], example?: string) {
    super('METHOD_NOT_ALLOWED', `Cannot ${method} ${path}; use ${allow.join(', ')}`, 405, {
      headers: { Allow: allow.join(', ') },
      details: {
        method,
        path,
        allowed: allow,
        ...(example === undefined ? {} : { example }),
      },
    });
  }
}

/** Normalise anything thrown into a `VavaLinkError`. */
export function toVavaLinkError(error: unknown): VavaLinkError {
  if (error instanceof VavaLinkError) return error;
  if (isAbortError(error)) return new ClientAbortedError(undefined, { cause: error });
  const message = error instanceof Error ? error.message : String(error);
  return new VavaLinkError('INTERNAL_ERROR', message, 500, {
    cause: error,
    expose: false,
  });
}

/** True for `AbortError` from Node/undici and our own client aborts. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof ClientAbortedError) return true;
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'ClientAbortError') return true;
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ABORT_ERR' || code === 'ECONNRESET' || code === 'EPIPE';
  }
  return false;
}