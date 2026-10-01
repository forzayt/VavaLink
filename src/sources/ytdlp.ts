/**
 * yt-dlp backed source.
 *
 * One implementation serves YouTube and SoundCloud: they differ only in the
 * search prefix and in which URLs they claim. Keeping them in a single class
 * means a fix to yt-dlp invocation, timeouts or EJS handling lands once.
 *
 * Why an external binary? yt-dlp is the de-facto standard for resolving media
 * URLs and is far more resilient to upstream changes than any in-process
 * extractor. Phase 1 pays the cost of one extra process per request; a later
 * phase can swap in a persistent process pool without changing this interface.
 */

import { z } from 'zod';

import { checkBinary, runProcess } from '../audio/ffmpeg.js';
import type { YtDlpSourceConfig } from '../config.js';
import { AbortScope, abortReason } from '../lib/async.js';
import { SourceUnavailableError, TrackUnavailableError, VavaLinkError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { isRemoteUrl } from './direct.js';
import { decodeTrackIdentifier, encodeTrackIdentifier } from './identifier.js';
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

export interface YtDlpSourceProfile {
  /** Source name reported on tracks, e.g. `youtube`. */
  readonly name: string;
  /** Search prefix understood by yt-dlp, e.g. `ytsearch`. */
  readonly searchPrefix: string;
  /** Hostnames this source claims. Empty means "claim every query". */
  readonly hosts: readonly string[];
  /** yt-dlp format selector, best first. */
  readonly formatSelector: string;
  /** Fallback artwork when the platform exposes none. */
  readonly fallbackArtwork: string | undefined;
  /** Human readable platform name for error messages. */
  readonly platformLabel: string;
}

export interface YtDlpSourceOptions {
  readonly profile: YtDlpSourceProfile;
  readonly config: YtDlpSourceConfig;
  readonly logger: Logger;
}

const thumbnailSchema = z.object({ url: z.string().nullish() }).passthrough();

const infoSchema = z
  .object({
    id: z.string().nullish(),
    title: z.string().nullish(),
    duration: z.union([z.number(), z.string()]).nullish(),
    webpage_url: z.string().nullish(),
    original_url: z.string().nullish(),
    uploader: z.string().nullish(),
    channel: z.string().nullish(),
    artist: z.string().nullish(),
    album: z.string().nullish(),
    thumbnail: z.string().nullish(),
    thumbnails: z.array(thumbnailSchema).nullish(),
    is_live: z.boolean().nullish(),
    live_status: z.string().nullish(),
    view_count: z.number().nullish(),
    extractor: z.string().nullish(),
    availability: z.string().nullish(),
    formats: z.array(z.unknown()).nullish(),
    requested_formats: z.array(z.unknown()).nullish(),
    http_headers: z.record(z.string(), z.string()).nullish(),
  })
  .passthrough();

const formatSchema = z
  .object({
    url: z.string().nullish(),
    ext: z.string().nullish(),
    acodec: z.string().nullish(),
    vcodec: z.string().nullish(),
    asr: z.number().nullish(),
    abr: z.number().nullish(),
    audio_channels: z.number().nullish(),
    filesize: z.number().nullish(),
    filesize_approx: z.number().nullish(),
    format_id: z.string().nullish(),
    http_headers: z.record(z.string(), z.string()).nullish(),
  })
  .passthrough();

type YtDlpInfo = z.infer<typeof infoSchema>;
type YtDlpFormat = z.infer<typeof formatSchema>;

const AVAILABILITY_TTL_MS = 30_000;

/**
 * yt-dlp reports `availability: "public"` for playable tracks; only these
 * values mean "you cannot listen to this".
 */
const UNAVAILABLE_REASONS = new Set([
  'private',
  'unlisted',
  'premium_only',
  'subscriber_only',
  'needs_auth',
  'unavailable',
  'geo_restricted',
  'age_restricted',
]);

export class YtDlpSource implements TrackSource {
  readonly name: string;

  readonly #profile: YtDlpSourceProfile;
  readonly #config: YtDlpSourceConfig;
  readonly #logger: Logger;
  #availability: { checkedAt: number; value: SourceAvailability } | undefined;

  constructor(options: YtDlpSourceOptions) {
    this.#profile = options.profile;
    this.#config = options.config;
    this.#logger = options.logger.child({ source: options.profile.name });
    this.name = options.profile.name;
  }

  canHandle(query: string): boolean {
    if (!this.#config.enabled) return false;
    const trimmed = query.trim();
    if (trimmed.length === 0) return false;

    // Free text is always searchable; a URL only when we own its host.
    if (!isRemoteUrl(trimmed)) return true;
    return this.#ownsUrl(trimmed);
  }

  /** True when the query is a URL on a host this source is responsible for. */
  #ownsUrl(value: string): boolean {
    if (!isRemoteUrl(value)) return false;
    if (this.#profile.hosts.length === 0) return true;

    try {
      const host = new URL(value).hostname.replace(/^www\./, '');
      return this.#profile.hosts.some((claimed) => host === claimed || host.endsWith(`.${claimed}`));
    } catch {
      return false;
    }
  }

  async search(query: string, options: SearchOptions): Promise<readonly TrackInfo[]> {
    this.#assertEnabled();
    const trimmed = query.trim();

    // A link to our own platform is an exact reference, not a search term:
    // resolve it directly so "youtube.com/watch?v=<id>" never turns into a
    // fuzzy search for that URL string.
    if (this.#ownsUrl(trimmed)) {
      const info = await this.#run(['--dump-single-json', '--no-playlist', trimmed], options);
      const track = this.#toTrackInfo(info);
      this.#logger.debug('resolved platform url', { query: trimmed, found: track !== null });
      return track === null ? [] : [track];
    }

    const limit = Math.max(1, Math.min(options.limit, 25));
    const target = `${this.#profile.searchPrefix}${limit}:${trimmed}`;

    this.#logger.debug('searching', { query: trimmed, target, limit });

    const info = await this.#run(['--dump-single-json', '--flat-playlist', target], options);

    const tracks = readEntries(info)
      .map((entry) => this.#toTrackInfo(entry))
      .filter((track): track is TrackInfo => track !== null)
      .slice(0, limit);

    this.#logger.debug('search completed', { query: trimmed, results: tracks.length });
    return tracks;
  }

  async open(track: TrackInfo, options: OpenOptions): Promise<AudioStream> {
    this.#assertEnabled();
    const target = this.#pageUrl(track);

    // A single metadata call yields the direct CDN url, the headers it needs and
    // the format properties - no second round trip.
    const info = await this.#run(
      ['--dump-single-json', '--no-playlist', '--format', this.#profile.formatSelector, target],
      options,
    );

    const availability = info.availability ?? 'public';
    if (availability !== 'public' && UNAVAILABLE_REASONS.has(availability)) {
      throw new TrackUnavailableError(
        `Track is not available on ${this.#profile.platformLabel}: ${availability}`,
        { details: { uri: target, availability } },
      );
    }

    const format = selectFormat(info);
    if (format?.url === null || format?.url === undefined) {
      throw new TrackUnavailableError(
        `No audio format available for this ${this.#profile.platformLabel} track`,
        { details: { uri: target } },
      );
    }

    return createAudioStream({
      contentType: contentTypeFor(format),
      url: format.url,
      requestHeaders: format.http_headers ?? info.http_headers ?? undefined,
      sizeBytes: format.filesize ?? format.filesize_approx ?? null,
      sampleRate: format.asr ?? null,
      channels: format.audio_channels ?? null,
    });
  }

  async isAvailable(): Promise<SourceAvailability> {
    if (!this.#config.enabled) {
      return { available: false, reason: 'disabled by configuration' };
    }

    const cached = this.#availability;
    if (cached !== undefined && Date.now() - cached.checkedAt < AVAILABILITY_TTL_MS) {
      return cached.value;
    }

    const check = await checkBinary(this.#config.binary, ['--version'], 5_000, this.#logger);
    const value: SourceAvailability = check.available
      ? { available: true, ...(check.version ? { version: check.version } : {}) }
      : { available: false, reason: check.reason ?? `${this.#config.binary} is not runnable` };

    this.#availability = { checkedAt: Date.now(), value };
    return value;
  }

  /** Run yt-dlp and parse its JSON payload. */
  async #run(args: readonly string[], options: OpenOptions | SearchOptions): Promise<YtDlpInfo> {
    const scope = AbortScope.create({
      timeoutMs: this.#config.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const fullArgs = [
      '--ignore-config',
      '--no-colors',
      '--no-warnings',
      ...(this.#config.jsRuntime ? ['--js-runtimes', this.#config.jsRuntime] : []),
      ...this.#config.extraArgs,
      ...args,
    ];

    try {
      const result = await runProcess(
        this.#config.binary,
        fullArgs,
        { timeoutMs: this.#config.timeoutMs, signal: scope.signal, maxStdoutChars: 8_000_000 },
        this.#logger,
      );

      const json = result.stdout.trim();
      if (json.length === 0) {
        throw new TrackUnavailableError('yt-dlp returned no data', { details: { source: this.name } });
      }

      const parsed = infoSchema.safeParse(JSON.parse(json));
      if (!parsed.success) {
        throw new TrackUnavailableError('Could not parse yt-dlp output', {
          cause: new Error(result.stdout.slice(0, 200)),
          details: {
            source: this.name,
            issues: parsed.error.issues.slice(0, 3).map((issue) => issue.path.join('.')),
          },
        });
      }

      return parsed.data;
    } catch (error) {
      if (scope.aborted) throw abortReason(scope.signal);
      throw remapYtDlpError(error, this.#profile.platformLabel);
    } finally {
      scope.dispose();
    }
  }

  #pageUrl(track: TrackInfo): string {
    if (track.uri !== undefined && isRemoteUrl(track.uri)) return track.uri;

    const key = decodeTrackIdentifier(track.identifier).sourceKey;
    return pageUrlFor(this.#profile, key);
  }

  #toTrackInfo(entry: YtDlpInfo): TrackInfo | null {
    const key = entry.id ?? entry.webpage_url ?? entry.original_url;
    if (key === null || key === undefined || key.length === 0) return null;

    const durationMs = toDurationMs(entry.duration);
    const isStream = entry.is_live === true || entry.live_status === 'is_live' || durationMs === 0;

    return {
      identifier: encodeTrackIdentifier({ sourceName: this.name, sourceKey: key }),
      title: entry.title?.trim() || key,
      author: entry.uploader ?? entry.channel ?? entry.artist ?? undefined,
      lengthMs: durationMs,
      isStream,
      sourceName: this.name,
      uri: entry.webpage_url ?? entry.original_url ?? pageUrlFor(this.#profile, key),
      artworkUrl: bestThumbnail(entry) ?? this.#profile.fallbackArtwork,
      encoded: false,
      userData: {
        platformId: key,
        viewCount: entry.view_count ?? null,
        extractor: entry.extractor ?? this.name,
      },
    };
  }

  #assertEnabled(): void {
    if (!this.#config.enabled) {
      throw new SourceUnavailableError(`The ${this.name} source is disabled`, {
        details: { source: this.name },
      });
    }
  }
}

/**
 * yt-dlp exit codes are coarse, so map well-known stderr shapes onto 404s.
 * Everything else stays a 502 so real upstream failures remain visible.
 */
const UNAVAILABLE_PATTERN = new RegExp(
  [
    'video is unavailable',
    'video unavailable',
    'private video',
    'removed by the uploader',
    'has been terminated',
    'is not available',
    'not available in your country',
    'does not exist',
    'no (?:video|audio) formats? found',
    'unsupported url',
    'sign in to confirm',
  ].join('|'),
  'i',
);

function remapYtDlpError(error: unknown, platformLabel: string): unknown {
  if (error instanceof TrackUnavailableError) return error;

  if (UNAVAILABLE_PATTERN.test(diagnosticsOf(error))) {
    return new TrackUnavailableError(`Track is not available on ${platformLabel}`, {
      cause: error,
      details: { reason: diagnosticsOf(error) },
    });
  }

  return error;
}

/** Best-effort "what did yt-dlp complain about" string. */
function diagnosticsOf(error: unknown): string {
  if (error instanceof VavaLinkError) {
    const stderr = error.details?.['stderr'];
    if (typeof stderr === 'string') return stderr;
  }
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  return `${message} ${cause}`;
}

function readEntries(info: YtDlpInfo): YtDlpInfo[] {
  const entries = (info as { entries?: unknown }).entries;
  if (Array.isArray(entries)) {
    return entries
      .map((entry) => infoSchema.safeParse(entry))
      .filter((result): result is { success: true; data: YtDlpInfo } => result.success)
      .map((result) => result.data);
  }
  // Without `--flat-playlist` (or for a single hit) the payload is one object.
  return info.id === null || info.id === undefined ? [] : [info];
}

/**
 * yt-dlp reports the chosen format inside `requested_formats` when a selector
 * resolves to a single entry; older versions only fill `formats`.
 */
function selectFormat(info: YtDlpInfo): YtDlpFormat | undefined {
  const candidates = [...(info.requested_formats ?? []), ...(info.formats ?? [])]
    .map((candidate) => formatSchema.safeParse(candidate))
    .filter((result): result is { success: true; data: YtDlpFormat } => result.success)
    .map((result) => result.data);

  const playable = candidates.filter(
    (format) => format.url !== null && format.url !== undefined && format.acodec !== 'none',
  );

  const ranked = playable.sort((a, b) => (b.abr ?? b.asr ?? 0) - (a.abr ?? a.asr ?? 0));
  return ranked[0] ?? candidates.find((format) => format.url !== null && format.url !== undefined);
}

function contentTypeFor(format: YtDlpFormat): string {
  const codec = (format.acodec ?? 'unknown').split('.')[0] || 'unknown';
  switch (format.ext) {
    case 'webm':
      return `audio/webm; codecs=${codec}`;
    case 'm4a':
    case 'mp4':
      return `audio/mp4; codecs=${codec}`;
    case 'oga':
    case 'opus':
      return `audio/ogg; codecs=${codec}`;
    case 'mp3':
      return 'audio/mpeg';
    default:
      return format.ext ? `audio/${format.ext}` : 'application/octet-stream';
  }
}

function toDurationMs(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1000);
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return Math.round(parsed * 1000);
  }
  return 0;
}

function bestThumbnail(entry: YtDlpInfo): string | undefined {
  if (entry.thumbnail !== null && entry.thumbnail !== undefined) return entry.thumbnail;
  const thumbnails = entry.thumbnails ?? [];
  for (let index = thumbnails.length - 1; index >= 0; index -= 1) {
    const url = thumbnails[index]?.url;
    if (url !== null && url !== undefined) return url;
  }
  return undefined;
}

function pageUrlFor(profile: YtDlpSourceProfile, key: string): string {
  if (key.startsWith('http')) return key;
  switch (profile.name) {
    case 'youtube':
      return `https://www.youtube.com/watch?v=${key}`;
    case 'soundcloud':
      return `https://soundcloud.com/${key}`;
    default:
      return key;
  }
}