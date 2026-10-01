/**
 * Source layer contracts.
 *
 * These types are the seam between "finding a track" and "producing audio for
 * it". Phase 1 uses them for a single HTTP request; a future
 * `loadtracks` -> `players/:id/play` flow will use the exact same interfaces
 * with a cache in between.
 */

import type { Readable } from 'node:stream';

/**
 * Track metadata, shaped after Lavalink's `TrackInfo` so a later API can be a
 * near drop-in for Lavalink clients.
 */
export interface TrackInfo {
  /** Opaque, URL-safe identifier produced by `encodeTrackIdentifier`. */
  readonly identifier: string;
  readonly title: string;
  readonly author: string | undefined;
  /** Duration in milliseconds. `0` for live streams / unknown. */
  readonly lengthMs: number;
  readonly isStream: boolean;
  /** Which source produced this track, e.g. `youtube`. */
  readonly sourceName: string;
  /** Canonical page URL (not the CDN media URL). */
  readonly uri: string | undefined;
  readonly artworkUrl: string | undefined;
  /**
   * Phase 1 always reports `false`: the audio is only produced when the client
   * actually asks for it. Lavalink flips this to `true` once a track is encoded
   * into a cached segment.
   */
  readonly encoded: boolean;
  /** Source specific extras (view count, uploader, ...). */
  readonly userData: Readonly<Record<string, unknown>> | undefined;
}

/** Everything needed to start reading a track's audio. */
export interface AudioStream {
  /** MIME type of the raw source audio, e.g. `audio/webm; codecs=opus`. */
  readonly contentType: string;
  /**
   * Remote URL handed to ffmpeg's input, or `null` when `stream` must be piped
   * into ffmpeg's stdin instead.
   */
  readonly url: string | null;
  /** Local path handed to ffmpeg's input, or `null`. */
  readonly filePath: string | null;
  /** Already-open body, used when `url`/`filePath` are `null`. */
  readonly stream: Readable | null;
  /** Extra HTTP headers ffmpeg must send with the input request. */
  readonly requestHeaders: Readonly<Record<string, string>> | undefined;
  /** Size in bytes when known, otherwise `null`. */
  readonly sizeBytes: number | null;
  /** Source sample rate when known, otherwise `null`. */
  readonly sampleRate: number | null;
  readonly channels: number | null;
}

export interface SearchOptions {
  /** Maximum number of candidates to return. */
  readonly limit: number;
  /** Deadline for the search itself. */
  readonly timeoutMs: number;
  /** Aborts when the HTTP client disconnects. */
  readonly signal?: AbortSignal;
}

export interface OpenOptions {
  /** Deadline for opening the audio source. */
  readonly timeoutMs: number;
  /** Aborts when the HTTP client disconnects. */
  readonly signal?: AbortSignal;
}

/**
 * A pluggable audio source (YouTube, SoundCloud, a direct URL, ...).
 *
 * Implementations must be stateless and safe for concurrent use.
 */
export interface TrackSource {
  readonly name: string;
  /** Cheap check: can this source answer the given query at all? */
  canHandle(query: string): boolean;
  /** Resolve a query into track candidates. */
  search(query: string, options: SearchOptions): Promise<readonly TrackInfo[]>;
  /** Turn a track into a playable audio stream. */
  open(track: TrackInfo, options: OpenOptions): Promise<AudioStream>;
  /** Whether the source's external dependency is usable right now. */
  isAvailable(): Promise<SourceAvailability>;
}

export interface SourceAvailability {
  readonly available: boolean;
  /** Short human readable reason when `available` is false. */
  readonly reason?: string;
  /** Dependency version, when cheap to obtain. */
  readonly version?: string;
}

export const NO_AVAILABILITY: SourceAvailability = { available: true };

/** Build an `AudioStream` with sane defaults so sources only set what they know. */
export function createAudioStream(init: Partial<AudioStream> & Pick<AudioStream, 'contentType'>): AudioStream {
  return {
    contentType: init.contentType,
    url: init.url ?? null,
    filePath: init.filePath ?? null,
    stream: init.stream ?? null,
    requestHeaders: init.requestHeaders,
    sizeBytes: init.sizeBytes ?? null,
    sampleRate: init.sampleRate ?? null,
    channels: init.channels ?? null,
  };
}