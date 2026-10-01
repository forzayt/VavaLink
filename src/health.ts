/**
 * Health reporting.
 *
 * Dependency probes are cached: `/health` is often scraped every few seconds and
 * we do not want a subprocess spawn per scrape. Pass `?refresh=true` to force a
 * re-probe.
 */

import { checkBinary, type BinaryCheck } from './audio/ffmpeg.js';
import type { AudioPipeline } from './audio/pipeline.js';
import type { AppConfig } from './config.js';
import type { Logger } from './lib/logger.js';
import type { SourceChain } from './sources/chain.js';

const CACHE_TTL_MS = 10_000;

export interface HealthCheck {
  readonly available: boolean;
  /** A failing required check downgrades the whole service to `degraded`. */
  readonly required: boolean;
  readonly version?: string;
  readonly reason?: string;
}

export interface HealthReport {
  readonly status: 'ok' | 'degraded';
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly timestamp: string;
  readonly audio: { readonly activeStreams: number; readonly ffmpeg: string };
  readonly checks: Readonly<Record<string, HealthCheck>>;
}

export interface HealthServiceOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly pipeline: AudioPipeline;
  readonly sources: SourceChain;
  readonly version: string;
}

export class HealthService {
  readonly #options: HealthServiceOptions;
  readonly #startedAt = performance.now();
  #cache: { at: number; report: HealthReport } | undefined;
  #inFlight: Promise<HealthReport> | undefined;

  constructor(options: HealthServiceOptions) {
    this.#options = options;
  }

  async report(options: { refresh?: boolean } = {}): Promise<HealthReport> {
    const cached = this.#cache;
    const fresh = cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS;

    if (fresh && options.refresh !== true) return cached.report;
    if (this.#inFlight !== undefined) return this.#inFlight;

    this.#inFlight = this.#collect()
      .then((report) => {
        this.#cache = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });

    return this.#inFlight;
  }

  async #collect(): Promise<HealthReport> {
    const { config, logger, pipeline, sources } = this.#options;

    const checks: Record<string, HealthCheck> = {};

    const ffmpeg = await checkBinary(config.audio.ffmpegPath, ['-version'], config.audio.binaryProbeTimeoutMs, logger);
    checks['ffmpeg'] = toCheck(ffmpeg, true);

    const ffprobe = await checkBinary(
      config.audio.ffprobePath,
      ['-version'],
      config.audio.binaryProbeTimeoutMs,
      logger,
    );
    checks['ffprobe'] = toCheck(ffprobe, true);

    const availability = await Promise.all(
      sources.sources.map(async (source) => [source.name, await source.isAvailable()] as const),
    );

    const anySourceEnabled = availability.some(([, value]) => value.available);

    for (const [name, value] of availability) {
      checks[`source.${name}`] = {
        available: value.available,
        required: false,
        ...(value.version ? { version: value.version } : {}),
        ...(value.reason ? { reason: value.reason } : {}),
      };
    }

    // FFmpeg is the only hard requirement; with no usable source at all the
    // server cannot do its job, so that is degraded too.
    const requiredOk = checks['ffmpeg']?.available === true && checks['ffprobe']?.available === true;
    const usable = anySourceEnabled || (config.sources.direct.enabled && ffmpeg.available);

    return {
      status: requiredOk && usable ? 'ok' : 'degraded',
      version: this.#options.version,
      uptimeSeconds: Math.round((performance.now() - this.#startedAt) / 1000),
      timestamp: new Date().toISOString(),
      audio: {
        activeStreams: pipeline.activeStreams,
        ffmpeg: config.audio.ffmpegPath,
      },
      checks,
    };
  }
}

function toCheck(check: BinaryCheck, required: boolean): HealthCheck {
  return {
    available: check.available,
    required,
    ...(check.version ? { version: check.version } : {}),
    ...(check.reason ? { reason: check.reason } : {}),
  };
}