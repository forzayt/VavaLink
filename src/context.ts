/**
 * Application context: the dependency graph for one server instance.
 *
 * Routes never construct their own collaborators, they receive the context -
 * which is what makes the whole stack testable and what a future plugin or
 * player manager can be constructed from.
 */

import { AudioPipeline } from './audio/pipeline.js';
import type { AppConfig } from './config.js';
import { HealthService } from './health.js';
import { createLogger, type Logger } from './lib/logger.js';
import { SourceChain } from './sources/chain.js';
import { DirectSource } from './sources/direct.js';
import { YtDlpSource, type YtDlpSourceProfile } from './sources/ytdlp.js';
import type { TrackSource } from './sources/types.js';

export const SERVICE_NAME = 'VavaLink';

export interface AppContext {
  readonly version: string;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly sources: SourceChain;
  readonly pipeline: AudioPipeline;
  readonly health: HealthService;
}

export interface CreateContextOptions {
  readonly config: AppConfig;
  readonly version: string;
  /** Injection seam for tests. */
  readonly logger?: Logger;
  /** Extra directories the direct source will search for local files. */
  readonly mediaSearchPaths?: readonly string[];
}

export function createContext(options: CreateContextOptions): AppContext {
  const { config, version } = options;
  const logger = options.logger ?? createLogger({ level: config.log.level, bindings: { service: SERVICE_NAME } });

  const pipeline = new AudioPipeline({
    ffmpegPath: config.audio.ffmpegPath,
    userAgent: config.audio.userAgent,
    sampleRate: config.audio.sampleRate,
    channels: config.audio.channels,
    logger: logger.child({ component: 'pipeline' }),
  });

  const sources: TrackSource[] = [];

  if (config.sources.direct.enabled) {
    sources.push(
      new DirectSource({
        enabled: config.sources.direct.enabled,
        ffprobePath: config.audio.ffprobePath,
        probeTimeoutMs: config.search.timeoutMs,
        searchPaths: options.mediaSearchPaths ?? [process.cwd()],
        reservedHosts: PLATFORM_HOSTS,
        logger: logger.child({ component: 'source', source: 'direct' }),
      }),
    );
  }

  if (config.sources.youtube.enabled) {
    sources.push(
      new YtDlpSource({
        profile: YOUTUBE_PROFILE,
        config: config.sources.youtube,
        logger: logger.child({ component: 'source' }),
      }),
    );
  }

  if (config.sources.soundcloud.enabled) {
    sources.push(
      new YtDlpSource({
        profile: SOUNDCLOUD_PROFILE,
        config: config.sources.soundcloud,
        logger: logger.child({ component: 'source' }),
      }),
    );
  }

  const chain = new SourceChain(sources, logger);

  const health = new HealthService({ config, logger, pipeline, sources: chain, version });

  return { version, config, logger, sources: chain, pipeline, health };
}

export const YOUTUBE_PROFILE: YtDlpSourceProfile = {
  name: 'youtube',
  searchPrefix: 'ytsearch',
  hosts: ['youtube.com', 'youtu.be', 'music.youtube.com'],
  formatSelector: 'bestaudio/best',
  fallbackArtwork: undefined,
  platformLabel: 'YouTube',
};

export const SOUNDCLOUD_PROFILE: YtDlpSourceProfile = {
  name: 'soundcloud',
  searchPrefix: 'scsearch',
  hosts: ['soundcloud.com'],
  formatSelector: 'bestaudio/best',
  fallbackArtwork: undefined,
  platformLabel: 'SoundCloud',
};

/** Hosts the direct source must not claim; they belong to a search source. */
const PLATFORM_HOSTS: readonly string[] = [...YOUTUBE_PROFILE.hosts, ...SOUNDCLOUD_PROFILE.hosts];