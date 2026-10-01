/**
 * Source chain: the "resolver" half of the architecture.
 *
 * `resolve` is the single entry point the HTTP layer uses today. A future
 * `loadtracks` endpoint would call `search` across the same chain, so the
 * ordering and fallback behaviour live here and nowhere else.
 */

import { NoMatchesError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { OpenOptions, SearchOptions, TrackInfo, TrackSource } from './types.js';

export interface ResolveRequest {
  readonly query: string;
  readonly limit: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ResolvedTrack {
  readonly track: TrackInfo;
  readonly source: TrackSource;
  /** Every source that was asked, in order. */
  readonly consulted: readonly string[];
  /** Milliseconds spent resolving. */
  readonly tookMs: number;
}

export class SourceChain {
  readonly #sources: readonly TrackSource[];
  readonly #logger: Logger;

  constructor(sources: readonly TrackSource[], logger: Logger) {
    this.#sources = sources;
    this.#logger = logger.child({ component: 'source-chain' });
  }

  get names(): readonly string[] {
    return this.#sources.map((source) => source.name);
  }

  get sources(): readonly TrackSource[] {
    return this.#sources;
  }

  /**
   * First match wins: walk the chain in order, return the best candidate of the
   * first source that claims the query.
   */
  async resolve(request: ResolveRequest): Promise<ResolvedTrack> {
    const startedAt = performance.now();
    const query = request.query.trim();
    const consulted: string[] = [];

    if (query.length === 0) {
      throw new NoMatchesError(request.query, consulted);
    }

    const searchOptions: SearchOptions = {
      limit: request.limit,
      timeoutMs: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    };

    for (const source of this.#sources) {
      if (!source.canHandle(query)) continue;
      consulted.push(source.name);

      const tracks = await source.search(query, searchOptions);
      const track = tracks[0];

      if (track !== undefined) {
        const tookMs = Math.round(performance.now() - startedAt);
        this.#logger.debug('resolved query', { query, source: source.name, tookMs });
        return { track, source, consulted, tookMs };
      }
    }

    this.#logger.debug('no matches', { query, consulted });
    throw new NoMatchesError(query, consulted);
  }

  /** Search every claiming source and concatenate the results. */
  async search(request: ResolveRequest): Promise<readonly TrackInfo[]> {
    const query = request.query.trim();
    if (query.length === 0) throw new NoMatchesError(request.query, []);

    const searchOptions: SearchOptions = {
      limit: request.limit,
      timeoutMs: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    };

    const results: TrackInfo[] = [];

    for (const source of this.#sources) {
      if (!source.canHandle(query)) continue;
      const tracks = await source.search(query, searchOptions);
      results.push(...tracks);
    }

    return results;
  }

  /** Open a track's audio using the source that produced it. */
  async open(
    track: TrackInfo,
    options: OpenOptions,
  ): Promise<{ stream: Awaited<ReturnType<TrackSource['open']>>; source: TrackSource }> {
    const source = this.#sources.find((candidate) => candidate.name === track.sourceName);
    if (source === undefined) {
      throw new NoMatchesError(track.sourceName, []);
    }
    const stream = await source.open(track, options);
    return { stream, source };
  }
}