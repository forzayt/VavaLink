/**
 * Direct source: audio that is already at a URL (or on local disk).
 *
 * No third-party dependency, which makes it the perfect fallback for testing
 * the audio pipeline end to end without touching a search backend - and a handy
 * escape hatch when a platform extractor breaks.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeMedia, type MediaInfo } from '../audio/probe.js';
import { SourceError, TrackUnavailableError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { encodeTrackIdentifier } from './identifier.js';
import {
  createAudioStream,
  NO_AVAILABILITY,
  type AudioStream,
  type OpenOptions,
  type SearchOptions,
  type SourceAvailability,
  type TrackInfo,
  type TrackSource,
} from './types.js';

/** Audio extensions we accept for local files. */
const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.wav',
  '.wma',
  '.webm',
  '.mp4',
  '.mka',
]);

export interface DirectSourceOptions {
  readonly enabled: boolean;
  readonly ffprobePath: string;
  readonly probeTimeoutMs: number;
  readonly logger: Logger;
  /** Directories searched when a query looks like a bare filename. */
  readonly searchPaths: readonly string[];
  /**
   * Hostnames owned by other sources (YouTube, SoundCloud, ...). The direct
   * source never claims them, so a platform link is never probed as a media
   * file before the owning source gets a chance.
   */
  readonly reservedHosts: readonly string[];
}

export class DirectSource implements TrackSource {
  readonly name = 'direct';

  readonly #options: DirectSourceOptions;
  readonly #logger: Logger;

  constructor(options: DirectSourceOptions) {
    this.#options = options;
    this.#logger = options.logger;
  }

  canHandle(query: string): boolean {
    if (!this.#options.enabled) return false;
    const trimmed = query.trim();
    if (trimmed.length === 0) return false;

    if (isRemoteUrl(trimmed)) return !isReservedHost(trimmed, this.#options.reservedHosts);
    return looksLikeAudioPath(trimmed);
  }

  async search(query: string, options: SearchOptions): Promise<readonly TrackInfo[]> {
    const raw = query.trim();
    const target = isRemoteUrl(raw) ? raw : await resolveLocalFile(raw, this.#options.searchPaths);

    if (target === null) {
      // Looks like a path but no such file: return nothing so the chain keeps
      // going and another source can try the query.
      this.#logger.debug('no local file matched', { query: raw });
      return [];
    }

    const isUrl = isRemoteUrl(target);
    const media = await this.#probe(target, options);

    if (media === null) {
      // Not playable media: stay quiet so the chain can try another source.
      this.#logger.debug('input is not playable media', { target });
      return [];
    }

    return [
      {
        identifier: encodeTrackIdentifier({ sourceName: this.name, sourceKey: target }),
        title: media.title ?? basename(target),
        author: media.artist ?? undefined,
        lengthMs: media.durationMs ?? 0,
        isStream: media.durationMs === null || media.durationMs === 0,
        sourceName: this.name,
        uri: target,
        artworkUrl: undefined,
        encoded: false,
        userData: {
          kind: isUrl ? 'url' : 'file',
          codec: media.codec,
          sampleRate: media.sampleRate,
          channels: media.channels,
          bitrate: media.bitrate,
        },
      },
    ];
  }

  async open(track: TrackInfo, options: OpenOptions): Promise<AudioStream> {
    const target = track.uri;
    if (target === undefined) {
      throw new TrackUnavailableError('Direct track is missing its URI');
    }

    const isUrl = isRemoteUrl(target);
    if (!isUrl) {
      // Fail fast with a clear message instead of letting ffmpeg report ENOENT.
      try {
        const stats = await stat(target);
        if (!stats.isFile()) throw new Error('not a file');
      } catch (cause) {
        throw new TrackUnavailableError(`Local file is not readable: ${target}`, { cause });
      }
    }

    options.signal?.throwIfAborted();

    return createAudioStream({
      contentType: 'application/octet-stream',
      ...(isUrl ? { url: target } : { filePath: target }),
      sizeBytes: null,
    });
  }

  async isAvailable(): Promise<SourceAvailability> {
    return NO_AVAILABILITY;
  }

  /** `null` means "this input is not media we can play". */
  async #probe(target: string, options: SearchOptions): Promise<MediaInfo | null> {
    try {
      return await probeMedia(target, {
        ffprobePath: this.#options.ffprobePath,
        timeoutMs: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
        logger: this.#logger,
      });
    } catch (error) {
      // A missing/unreachable host or a missing ffprobe is a real problem and
      // must surface; "this is not audio" simply means we cannot help.
      if (isNotMediaError(error)) return null;
      throw error;
    }
  }
}

export function isRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isReservedHost(value: string, reserved: readonly string[]): boolean {
  if (reserved.length === 0) return false;
  try {
    const host = new URL(value).hostname.replace(/^www\./, '');
    return reserved.some((claimed) => host === claimed || host.endsWith(`.${claimed}`));
  } catch {
    return false;
  }
}

function looksLikeAudioPath(value: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function basename(target: string): string {
  try {
    const url = new URL(target);
    const name = path.posix.basename(url.pathname);
    if (name.length === 0) return url.hostname;
    return path.basename(decodeURIComponent(name));
  } catch {
    return path.basename(target);
  }
}

/** Look for a local file in the query itself and then in the search paths. */
async function resolveLocalFile(raw: string, searchPaths: readonly string[]): Promise<string | null> {
  const candidates = [raw, ...searchPaths.map((dir) => path.join(dir, raw))];

  for (const candidate of candidates) {
    const absolute = path.resolve(candidate.startsWith('file://') ? fileURLToPath(candidate) : candidate);
    try {
      const stats = await stat(absolute);
      if (stats.isFile()) return absolute;
    } catch {
      /* try the next candidate */
    }
  }

  return null;
}

/** ffprobe stderr shapes that mean "this input is not decodable media". */
const NOT_MEDIA_PATTERN =
  /invalid data found when processing input|invalid argument|moov atom not found|no such file or directory|unknown format|404 not found/i;

function isNotMediaError(error: unknown): boolean {
  if (!(error instanceof SourceError)) return false;
  const stderr = error.details?.['stderr'];
  return typeof stderr === 'string' && NOT_MEDIA_PATTERN.test(stderr);
}