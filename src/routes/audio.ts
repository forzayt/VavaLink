/**
 * `POST /v1/audio` + `GET /v1/audio[/{link}]` - the Phase 1 end-to-end flow.
 *
 * POST: { "query": "never gonna give you up" }
 * GET:  /v1/audio/https://youtu.be/3sB4Iv_tM7U
 * GET:  /v1/audio?query=https://youtu.be/3sB4Iv_tM7U
 * GET:  /v1/audio?url=https://youtu.be/3sB4Iv_tM7U
 *
 * Both resolve via sources (metadata only) -> ffmpeg transcode ->
 * audio/mpeg (or audio/L16 PCM) streamed straight to the client.
 *
 * Nothing touches the disk. The response is chunked, so playback starts as soon
 * as the first frames are ready. The GET URL itself is therefore directly
 * playable in a browser `<audio>` tag, VLC, or Discord.
 *
 * `?format=json` (or `?direct=true`) instead returns the resolved direct
 * CDN URL as JSON without transcoding.
 *
 * Client disconnects are first-class: they abort the source lookup, kill ffmpeg
 * and tear down the socket instead of logging an error.
 */

import { pipeline as streamPipeline } from 'node:stream/promises';

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { ENCODING_NAMES, resolveEncoding, type Encoding, type EncodingName } from '../audio/encoding.js';
import type { EncodedAudio } from '../audio/pipeline.js';
import type { AppContext } from '../context.js';
import { ClientAbortedError, ValidationError } from '../lib/errors.js';
import type { TrackInfo } from '../sources/types.js';

const audioRequestSchema = z.object({
  query: z
    .string({ error: 'query must be a string' })
    .trim()
    .min(1, 'query must not be empty')
    .max(500, 'query must be 500 characters or fewer')
    .refine((value) => !hasControlCharacters(value), {
      message: 'query must not contain control characters',
    }),
  /** Output encoding; defaults to DEFAULT_ENCODING (mp3). */
  encoding: z.enum(ENCODING_NAMES).optional(),
});

/** Control characters would corrupt headers and log lines. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function createAudioRouter(context: AppContext): Router {
  const router = Router();

  router.post('/audio', async (req: Request, res: Response, next): Promise<void> => {
    const payload = audioRequestSchema.safeParse(req.body);
    if (!payload.success) {
      next(
        new ValidationError('Invalid request body', {
          details: {
            issues: payload.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        }),
      );
      return;
    }

    await streamAudio(
      context,
      req,
      res,
      next,
      payload.data.query,
      payload.data.encoding ?? context.config.audio.defaultEncoding,
    );
  });

  // GET /v1/audio?query=<link> (or ?url= / ?link=) — best for URLs containing
  // `?` and `&`, e.g. youtube watch links.
  router.get('/audio', async (req: Request, res: Response, next): Promise<void> => {
    await handleGetAudio(context, req, res, next);
  });

  // GET /v1/audio/{link} — e.g. /v1/audio/https://youtu.be/3sB4Iv_tM7U
  // Express 5 requires a named wildcard (`*splat`); `req.params.splat` holds
  // everything after `/audio/`, slashes included.
  router.get('/audio/*splat', async (req: Request, res: Response, next): Promise<void> => {
    await handleGetAudio(context, req, res, next);
  });

  return router;
}

/** Shared GET handler for both `/audio` and `/audio/*splat`. */
async function handleGetAudio(
  context: AppContext,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const encodingParam = firstQueryParam(req.query['encoding']);
  const formatParam = firstQueryParam(req.query['format'] ?? req.query['direct']);

  const encodingName = encodingParam ?? context.config.audio.defaultEncoding;
  if (!(ENCODING_NAMES as readonly string[]).includes(encodingName)) {
    next(
      new ValidationError('Invalid encoding', {
        details: { allowed: ENCODING_NAMES, received: encodingParam },
      }),
    );
    return;
  }

  const query = extractGetQuery(req);
  if (query === undefined || query.trim().length === 0) {
    next(
      new ValidationError('Missing audio link', {
        details: { hint: 'Use GET /v1/audio/{link} or GET /v1/audio?query={link}' },
      }),
    );
    return;
  }

  if (query.length > 500) {
    next(new ValidationError('query must be 500 characters or fewer'));
    return;
  }
  if (hasControlCharacters(query)) {
    next(new ValidationError('query must not contain control characters'));
    return;
  }

  // `?format=json` (or `?direct=true` / `?format=direct`) returns the
  // resolved direct CDN URL as JSON instead of a transcoded stream.
  if (formatParam !== undefined && /^(json|direct|true|1)$/i.test(formatParam)) {
    await resolveToPlayableUrl(context, req, res, next, query);
    return;
  }

  // Browser address-bar navigation sends `Accept: text/html` and then stares
  // at an empty tab for ~10s (two yt-dlp calls + ffmpeg buffering) before a
  // single byte arrives. Serve an instant player page instead; its `<audio>`
  // element holds the connection and starts playback when the stream is
  // ready. `?raw=1` forces the raw audio stream (used by the page itself,
  // curl, `<audio src>`, Discord, ...).
  const rawParam = firstQueryParam(req.query['raw'] ?? req.query['play']);
  const wantsRaw = rawParam !== undefined && /^(1|true|raw|audio)$/i.test(rawParam);
  const accept = req.header('accept') ?? '';
  if (!wantsRaw && accept.includes('text/html')) {
    res.status(200).type('text/html; charset=utf-8').send(playerPage(req, query, encodingName));
    return;
  }

  await streamAudio(context, req, res, next, query, encodingName);
}

/** Minimal auto-playing page for browser navigations to a stream URL. */
function playerPage(req: Request, query: string, encodingName: string): string {
  const sep = (req.originalUrl ?? '').includes('?') ? '&' : '?';
  const streamHref = `${req.originalUrl ?? req.path}${sep}raw=1`;
  const metaHref = `${req.originalUrl ?? req.path}${sep}format=json`;
  const esc = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VavaLink player</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111; color: #eee; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { text-align: center; max-width: 28rem; padding: 2rem; }
  h1 { font-size: 1.1rem; font-weight: 600; }
  p { color: #999; font-size: 0.85rem; word-break: break-all; }
  audio { width: 100%; margin-top: 1rem; }
</style>
</head>
<body>
<main>
  <h1 id="title">Loading…</h1>
  <p id="source">${esc(query)} · ${esc(encodingName)}</p>
  <audio controls autoplay preload="auto" src="${esc(streamHref)}"></audio>
</main>
<script>
  fetch(${JSON.stringify(metaHref)}, { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d || !d.track) return;
      const label = d.track.author ? d.track.title + ' — ' + d.track.author : d.track.title;
      document.title = label;
      document.getElementById('title').textContent = label;
    })
    .catch(() => {});
  document.querySelector('audio').addEventListener('playing', () => {
    document.getElementById('title').textContent = document.title;
  });
</script>
</body>
</html>`;
}

/**
 * Resolve a track and return its direct playable URL as JSON (no transcoding).
 * Note: CDN URLs expire and may require the returned `requestHeaders`.
 */
async function resolveToPlayableUrl(
  context: AppContext,
  req: Request,
  res: Response,
  next: NextFunction,
  query: string,
): Promise<void> {
  const controller = new AbortController();
  const onClose = (): void => {
    controller.abort(new ClientAbortedError('Client closed the connection'));
  };
  res.on('close', onClose);
  try {
    const resolved = await context.sources.resolve({
      query,
      limit: 1,
      timeoutMs: context.config.search.timeoutMs,
      signal: controller.signal,
    });

    const { stream } = await context.sources.open(resolved.track, {
      timeoutMs: context.config.search.timeoutMs,
      signal: controller.signal,
    });

    res.status(200).json({
      track: {
        identifier: resolved.track.identifier,
        title: resolved.track.title,
        author: resolved.track.author ?? null,
        lengthMs: resolved.track.lengthMs,
        isStream: resolved.track.isStream,
        sourceName: resolved.track.sourceName,
        uri: resolved.track.uri ?? null,
        artworkUrl: resolved.track.artworkUrl ?? null,
      },
      // Direct upstream URL — playable as-is while it lives.
      playableUrl: stream.url ?? stream.filePath ?? resolved.track.uri,
      contentType: stream.contentType,
      requestHeaders: stream.requestHeaders ?? null,
      sizeBytes: stream.sizeBytes,
      source: resolved.source.name,
      tookMs: resolved.tookMs,
    });
  } catch (error) {
    next(error);
  } finally {
    res.off('close', onClose);
  }
}

/** First value of a query param (`?encoding=mp3&encoding=pcm` -> `mp3`). */
function firstQueryParam(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') return entry;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Extract the audio query from a GET request.
 *
 * Priority:
 *  1. `?query=` / `?url=` / `?link=` (required for youtube watch URLs with
 *     `?v=` + `&list=`, which cannot survive raw in a path segment).
 *  2. Everything after `/v1/audio/` in `originalUrl`, so
 *     `GET /v1/audio/https://youtu.be/3sB4Iv_tM7U` works. Unknown query keys
 *     (e.g. `?v=...`) are re-attached to the link; our own control keys
 *     (`encoding`, `format`, `direct`, `query`, `url`, `link`) are stripped.
 *  3. `req.params.splat` fallback (Express 5 named wildcard).
 */
function extractGetQuery(req: Request): string | undefined {
  const fromParam =
    firstQueryParam(req.query['query']) ??
    firstQueryParam(req.query['url']) ??
    firstQueryParam(req.query['link']);
  if (fromParam !== undefined && fromParam.trim().length > 0) return fromParam.trim();

  const CONTROL_KEYS = new Set(['encoding', 'format', 'direct', 'query', 'url', 'link']);
  const originalUrl: string = req.originalUrl ?? req.url ?? '';

  const prefix = '/v1/audio';
  const prefixIndex = originalUrl.indexOf(prefix);
  if (prefixIndex >= 0) {
    let remainder = originalUrl.slice(prefixIndex + prefix.length);
    const hashIndex = remainder.indexOf('#');
    if (hashIndex >= 0) remainder = remainder.slice(0, hashIndex);
    // Split path vs query string without losing raw `?v=` links.
    const qIndex = remainder.indexOf('?');
    const pathPart = qIndex >= 0 ? remainder.slice(0, qIndex) : remainder;
    const rawQs = qIndex >= 0 ? remainder.slice(qIndex + 1) : '';

    // Re-attach unknown query pairs (the embedded link's own `?v=&t=`).
    let extraQs = '';
    if (rawQs.length > 0) {
      const kept: string[] = [];
      for (const pair of rawQs.split('&')) {
        if (pair.length === 0) continue;
        const key = decodeURIComponentSafe(pair.split('=')[0] ?? '').toLowerCase();
        if (!CONTROL_KEYS.has(key)) kept.push(pair);
      }
      if (kept.length > 0) extraQs = kept.join('&');
    }

    let link = pathPart.startsWith('/') ? pathPart.slice(1) : pathPart;
    link = decodeURIComponentSafe(link).trim();
    if (extraQs.length > 0) link = `${link}?${extraQs}`;
    if (link.length > 0) return link;
  }

  // Fallback: Express 5 `*splat` param (string | string[] | object).
  const splat = (req.params as Record<string, unknown>)['splat'];
  if (typeof splat === 'string' && splat.trim().length > 0) {
    return decodeURIComponentSafe(splat).trim();
  }
  if (Array.isArray(splat)) {
    const joined = splat.join('/').trim();
    if (joined.length > 0) return decodeURIComponentSafe(joined).trim();
  }
  return undefined;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Transcode `query` and stream it to the client (shared by POST + GET). */
async function streamAudio(
  context: AppContext,
  req: Request,
  res: Response,
  next: NextFunction,
  query: string,
  encodingName: string,
): Promise<void> {
  const controller = new AbortController();
  let responseFinished = false;

  // `res.close` fires on normal completion *and* on disconnect; the flag
  // distinguishes "client hung up mid-stream" from "we are done".
  const onClose = (): void => {
    if (!responseFinished) {
      controller.abort(new ClientAbortedError('Client closed the connection'));
    }
  };
  res.on('close', onClose);

  const log = context.logger.child({ component: 'audio', id: req.id });
  let session: EncodedAudio | undefined;

  try {
    const encoding = resolveEncoding(encodingName as EncodingName, {
      sampleRate: context.config.audio.sampleRate,
      channels: context.config.audio.channels,
      mp3BitrateKbps: context.config.audio.mp3BitrateKbps,
    });

    const resolved = await context.sources.resolve({
      query,
      limit: 1,
      timeoutMs: context.config.search.timeoutMs,
      signal: controller.signal,
    });

    if (controller.signal.aborted) {
      throw new ClientAbortedError('Client closed the connection');
    }

    setStreamHeaders(res, resolved.track, encoding, resolved.tookMs);
    res.status(200);

    session = await context.pipeline.encode({
      track: resolved.track,
      source: resolved.source,
      encoding,
      signal: controller.signal,
      openTimeoutMs: context.config.search.timeoutMs,
    });

    log.info('streaming track', {
      source: resolved.track.sourceName,
      title: resolved.track.title,
      encoding: encoding.name,
      lengthMs: resolved.track.lengthMs,
    });

    await streamPipeline(session.stream, res);
    responseFinished = true;

    log.info('stream completed', { bytes: session.bytes(), encoding: encoding.name });
  } catch (error) {
    if (isPrematureClose(error)) {
      // Client vanished while we were writing; the abort listener above has
      // already stopped ffmpeg.
      log.debug('client disconnected mid-stream', { bytes: session?.bytes() ?? 0 });
      responseFinished = true;
      return;
    }

    if (error instanceof ClientAbortedError) {
      log.debug('request aborted', { bytes: session?.bytes() ?? 0 });
      responseFinished = true;
      return;
    }

    next(error);
  } finally {
    res.off('close', onClose);
    if (!responseFinished) controller.abort();
    session?.dispose('request-finished');
  }
}

/** Metadata rides along in headers so a client can log what it received. */
function setStreamHeaders(
  res: Response,
  track: TrackInfo,
  encoding: Encoding,
  resolveMs: number,
): void {
  res.setHeader('Content-Type', encoding.contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-VavaLink-Encoding', encoding.name);
  res.setHeader('X-VavaLink-Track-Id', track.identifier);
  res.setHeader('X-VavaLink-Source', track.sourceName);
  res.setHeader('X-VavaLink-Title', headerSafe(track.title));
  res.setHeader('X-VavaLink-Author', headerSafe(track.author ?? 'unknown'));
  res.setHeader('X-VavaLink-Duration-Ms', String(track.lengthMs));
  res.setHeader('X-VavaLink-Is-Stream', String(track.isStream));
  res.setHeader('X-VavaLink-Resolve-Ms', String(resolveMs));
  if (track.artworkUrl !== undefined) {
    res.setHeader('X-VavaLink-Artwork', headerSafe(track.artworkUrl));
  }
}

/** Header values must be latin-1 safe. */
function headerSafe(value: string): string {
  return encodeURIComponent(value);
}

/** `stream.pipeline` rejects with this when the socket disappears early. */
function isPrematureClose(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE'
  );
}

/** Exported for tests: the request schema is part of the public contract. */
export { audioRequestSchema, hasControlCharacters };