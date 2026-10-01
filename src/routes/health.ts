/**
 * Health and service metadata endpoints.
 *
 * `GET /health` is the readiness probe: it returns 503 when a hard dependency
 * (ffmpeg/ffprobe) is missing so orchestrators do not route traffic to a server
 * that cannot transcode. Dependency checks are cached - see `HealthService`.
 */

import { Router } from 'express';

import { SERVICE_NAME, type AppContext } from '../context.js';

export function createHealthRouter(context: AppContext): Router {
  const router = Router();

  router.get('/health', async (req, res): Promise<void> => {
    const report = await context.health.report({ refresh: req.query['refresh'] === 'true' });

    res.status(report.status === 'ok' ? 200 : 503);
    res.setHeader('Cache-Control', 'no-store');

    if (!context.config.health.verbose) {
      res.json({
        status: report.status,
        version: report.version,
        uptimeSeconds: report.uptimeSeconds,
      });
      return;
    }

    res.json(report);
  });

  return router;
}

export function createRootRouter(context: AppContext): Router {
  const router = Router();

  /** Cheap "what is this service" payload, handy for humans and bots. */
  router.get('/', (_req, res): void => {
    res.json({
      service: SERVICE_NAME,
      version: context.version,
      phase: 1,
      endpoints: {
        health: 'GET /health',
        audio: 'POST /v1/audio',
      },
      sources: context.sources.names,
      encoding: {
        default: context.config.audio.defaultEncoding,
        supported: ['mp3', 'pcm'],
        sampleRate: context.config.audio.sampleRate,
        channels: context.config.audio.channels,
      },
    });
  });

  return router;
}