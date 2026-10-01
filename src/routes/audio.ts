/**
 * `POST /v1/audio` - the Phase 1 end-to-end flow.
 *
 *   { "query": "never gonna give you up" }
 *     -> source resolution (metadata only)
 *     -> ffmpeg transcode
 *     -> audio/mpeg (or audio/L16 PCM) streamed straight to the client
 *
 * Nothing touches the disk. The response is chunked, so playback starts as soon
 * as the first frames are ready.
 *
 * Client disconnects are first-class: they abort the source lookup, kill ffmpeg
 * and tear down the socket instead of logging an error.
 */

import { pipeline as streamPipeline } from 'node:stream/promises';

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { ENCODING_NAMES, resolveEncoding, type Encoding } from '../audio/encoding.js';
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
      const payload = parseAudioRequest(req.body);
      if (!payload.success) {
        throw new ValidationError('Invalid request body', {
          details: {
            issues: payload.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
      }

      const encoding = resolveEncoding(payload.data.encoding ?? context.config.audio.defaultEncoding, {
        sampleRate: context.config.audio.sampleRate,
        channels: context.config.audio.channels,
        mp3BitrateKbps: context.config.audio.mp3BitrateKbps,
      });

      const resolved = await context.sources.resolve({
        query: payload.data.query,
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
  });

  return router;
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