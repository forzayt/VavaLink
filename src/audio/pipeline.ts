/**
 * Audio pipeline: track -> source bytes -> ffmpeg -> encoded stream.
 *
 * This is the piece that stays useful when the HTTP API changes. A future
 * `POST /v1/players/:id/play` will call `pipeline.encode()` exactly the same way
 * `POST /v1/audio` does today; only the transport around it changes.
 *
 * Guarantees:
 *  - nothing is written to disk;
 *  - the ffmpeg child is always killed when the request aborts or shutdown runs;
 *  - failures propagate as `VavaLinkError`s on the returned stream.
 */

import { PassThrough, type Readable, type Writable } from 'node:stream';

import type { Logger } from '../lib/logger.js';
import type { AudioStream, TrackInfo, TrackSource } from '../sources/types.js';
import { TrackUnavailableError, EncodingError } from '../lib/errors.js';
import { spawnFfmpeg, type FfmpegProcess } from './ffmpeg.js';
import type { Encoding } from './encoding.js';

/**
 * How long we wait for ffmpeg's first byte before streaming anyway. A broken
 * input fails in well under this; a slow CDN must not be held hostage.
 */
const FIRST_OUTPUT_TIMEOUT_MS = 5_000;

export interface PipelineOptions {
  readonly ffmpegPath: string;
  readonly userAgent: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly logger: Logger;
}

export interface EncodeRequest {
  readonly track: TrackInfo;
  readonly source: TrackSource;
  readonly encoding: Encoding;
  /** Aborts the stream; used for client disconnects and server shutdown. */
  readonly signal: AbortSignal;
  /** Deadline for opening the source stream (not for the whole transfer). */
  readonly openTimeoutMs?: number;
}

export interface EncodedAudio {
  /** Encoded audio. Attach an `error` listener and pipe it to the client. */
  readonly stream: Readable;
  readonly encoding: Encoding;
  readonly input: AudioStream;
  /** Bytes ffmpeg has produced so far (approximate once backpressure kicks in). */
  bytes(): number;
  /** Kill ffmpeg and release every resource. Idempotent. */
  dispose(reason?: string): void;
  /** Resolves when ffmpeg exits cleanly, rejects with a typed error. */
  readonly done: Promise<void>;
}

export class AudioPipeline {
  readonly #options: PipelineOptions;
  readonly #sessions = new Set<EncodeSession>();

  constructor(options: PipelineOptions) {
    this.#options = options;
  }

  /** Number of encoders currently running. Surfaced by `/health`. */
  get activeStreams(): number {
    return this.#sessions.size;
  }

  /**
   * Open a track's audio and start transcoding it.
   *
   * Resolves as soon as ffmpeg is running; the caller streams `stream`.
   */
  async encode(request: EncodeRequest): Promise<EncodedAudio> {
    const { track, source, encoding, signal } = request;

    const input = await source.open(track, {
      timeoutMs: request.openTimeoutMs ?? 20_000,
      signal,
    });

    const args = buildFfmpegArgs({
      input,
      encoding,
      userAgent: this.#options.userAgent,
      sampleRate: this.#options.sampleRate,
      channels: this.#options.channels,
      isStream: track.isStream,
    });

    const session = new EncodeSession({
      ffmpegPath: this.#options.ffmpegPath,
      args,
      input,
      encoding,
      track,
      signal,
      logger: this.#options.logger.child({ track: track.identifier }),
    });

    this.#sessions.add(session);
    try {
      await session.start();
    } catch (error) {
      this.#sessions.delete(session);
      session.dispose();
      throw error;
    }

    session.onFinished(() => this.#sessions.delete(session));
    return session;
  }

  /** Terminate every running encoder. Used on graceful shutdown. */
  async closeAll(reason = 'shutdown'): Promise<void> {
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map(async (session) => session.dispose(reason)));
  }
}

interface BuildArgsInput {
  readonly input: AudioStream;
  readonly encoding: Encoding;
  readonly userAgent: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly isStream: boolean;
}

/**
 * Build the ffmpeg command line.
 *
 * Exported so the argument list can be unit tested without spawning anything.
 */
export function buildFfmpegArgs(input: BuildArgsInput): string[] {
  const { input: source, encoding } = input;

  const args: string[] = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
  ];

  // Keep ffmpeg from reading the console when we hand it a URL to a live source.
  if (input.isStream) args.push('-fflags', '+genpts+nobuffer+discardcorrupt');

  const usesStdin = source.url === null && source.filePath === null;

  // `-user_agent` / `-headers` are HTTP protocol options: ffmpeg rejects them
  // outright when the input is a file, so only send them for remote inputs.
  const remoteInput = !usesStdin && source.url !== null && /^https?:/i.test(source.url);

  if (remoteInput) {
    args.push('-user_agent', input.userAgent);

    const headers = source.requestHeaders;
    if (headers && Object.keys(headers).length > 0) {
      const serialized = Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n');
      args.push('-headers', `${serialized}\r\n`);
    }
  }

  args.push('-i', usesStdin ? 'pipe:0' : (source.url ?? source.filePath ?? 'pipe:0'));

  // First audio stream only, audio only, normalised format.
  args.push('-map', '0:a:0', '-vn', '-sn', '-dn');
  args.push('-ar', String(input.sampleRate), '-ac', String(input.channels));

  // Live sources get an async resampler so A/V stay in sync.
  if (input.isStream) args.push('-af', 'aresample=async=1:first_pts=0');

  args.push(...encoding.outputArgs);
  return args;
}

interface SessionInit {
  readonly ffmpegPath: string;
  readonly args: readonly string[];
  readonly input: AudioStream;
  readonly encoding: Encoding;
  readonly track: TrackInfo;
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

/**
 * One ffmpeg process plus the PassThrough that fronts it.
 *
 * The PassThrough exists so we own the readable handed to the HTTP layer: we can
 * always destroy it with a typed error, and we can count bytes without
 * disturbing ffmpeg's stdout.
 */
class EncodeSession implements EncodedAudio {
  readonly stream: PassThrough;
  readonly encoding: Encoding;
  readonly input: AudioStream;
  readonly #logger: Logger;
  readonly #signal: AbortSignal;
  readonly #track: TrackInfo;
  readonly #ffmpegPath: string;
  readonly #args: readonly string[];
  #process: FfmpegProcess | undefined;
  #bytes = 0;
  #disposed = false;
  #finishedHandlers: Array<() => void> = [];

  constructor(init: SessionInit) {
    this.#ffmpegPath = init.ffmpegPath;
    this.#args = init.args;
    this.input = init.input;
    this.encoding = init.encoding;
    this.#track = init.track;
    this.#signal = init.signal;
    this.#logger = init.logger;

    this.stream = new PassThrough({ highWaterMark: 64 * 1024 });
    // Safety net: without a listener an 'error' event would take the process
    // down. The consumer attaches its own handler; this one just prevents a
    // crash during the (small) window before it does.
    this.stream.on('error', () => {
      /* consumed by the HTTP layer */
    });
  }

  bytes(): number {
    return this.#bytes;
  }

  /** Spawn ffmpeg and wire it to {@link stream}. */
  async start(): Promise<void> {
    if (this.#signal.aborted) {
      throw (this.#signal.reason as Error | undefined) ?? new Error('Aborted before start');
    }

    const usesStdin = this.input.url === null && this.input.filePath === null && this.input.stream !== null;
    const process = spawnFfmpeg(this.#ffmpegPath, this.#args, { withStdin: usesStdin }, this.#logger);
    this.#process = process;

    // Wait until ffmpeg is actually alive *and* producing audio before we let
    // the caller write a 200 to the client. Otherwise a missing binary or a
    // bad input URL would surface as a truncated response instead of a clean
    // 503/502 body.
    await this.#awaitReady(process);

    process.stdout.on('data', (chunk: Buffer) => {
      this.#bytes += chunk.length;
    });

    process.stdout.on('error', (error: Error) => {
      this.stream.destroy(error);
    });

    process.stdout.on('end', () => {
      if (!this.stream.destroyed) this.stream.end();
    });

    // `end: false` so the PassThrough is closed by the handler above, which
    // keeps ownership of "when does this stream end" in one place.
    process.stdout.pipe(this.stream, { end: false });

    process.done.catch((error: unknown) => {
      // `done` is also surfaced through the stream; do not double-report.
      this.#logger.debug('encoder finished with error', { reason: describeError(error) });
    });

    const onAbort = (): void => {
      this.#logger.debug('request aborted, stopping encoder', { track: this.#track.title });
      process.kill('client-abort');
    };
    this.#signal.addEventListener('abort', onAbort, { once: true });
    process.done
      .catch(() => undefined)
      .finally(() => this.#signal.removeEventListener('abort', onAbort));

    if (usesStdin && this.input.stream && process.stdin) {
      this.#pipeInput(this.input.stream, process.stdin);
    }

    this.#logger.debug('encoder started', {
      encoding: this.encoding.name,
      pid: process.child.pid,
      input: this.input.url ?? this.input.filePath ?? 'stdin',
    });
  }

  /**
   * Resolve once the process is spawned and has emitted its first byte, reject
   * if it dies first. Bounded by {@link FIRST_OUTPUT_TIMEOUT_MS} so a slow
   * source can never stall a response.
   */
  #awaitReady(process: FfmpegProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        process.child.off('spawn', onSpawn);
        process.child.off('error', onError);
        process.stdout.off('data', onData);
        process.stdout.off('end', onEnd);
      };

      const settle = (action: () => void): void => {
        cleanup();
        action();
      };

      const onSpawn = (): void => {
        this.#logger.debug('ffmpeg spawned', { pid: process.child.pid });
      };
      const onData = (): void => settle(resolve);
      const onEnd = (): void => settle(() => reject(new EncodingError('FFmpeg produced no audio')));
      const onError = (error: Error): void => settle(() => reject(error));

      const timer = setTimeout(() => settle(resolve), FIRST_OUTPUT_TIMEOUT_MS);
      timer.unref();

      process.child.once('spawn', onSpawn);
      process.child.once('error', onError);
      process.stdout.once('data', onData);
      process.stdout.once('end', onEnd);

      // `spawnFfmpeg` classifies failures on `done`; reuse that verdict.
      process.done.catch((error: unknown) => {
        settle(() =>
          reject(
            error instanceof Error
              ? error
              : new EncodingError('FFmpeg failed before producing audio'),
          ),
        );
      });
    });
  }

  get done(): Promise<void> {
    return this.#process?.done ?? Promise.reject(new TrackUnavailableError('Encoder was never started'));
  }

  onFinished(handler: () => void): void {
    if (this.#disposed) {
      handler();
      return;
    }
    this.#finishedHandlers.push(handler);
  }

  async dispose(reason = 'dispose'): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;

    this.#process?.kill(reason);
    destroyQuietly(this.input.stream);
    destroyQuietly(this.stream);

    const handlers = this.#finishedHandlers;
    this.#finishedHandlers = [];
    for (const handler of handlers) handler();
  }

  #pipeInput(source: Readable, target: Writable): void {
    source.on('error', (error: Error) => {
      target.destroy(error);
      this.stream.destroy(error);
    });
    source.pipe(target);
  }
}

function destroyQuietly(stream: Readable | Writable | null): void {
  if (!stream || stream.destroyed) return;
  stream.destroy();
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}