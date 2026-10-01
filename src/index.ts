/**
 * VavaLink entrypoint.
 *
 * Responsibilities: load config, build the dependency graph, start listening,
 * and shut everything down cleanly (including every ffmpeg child still running).
 */

import process from 'node:process';

import { createServer, type Server } from 'node:http';

import { ConfigError, describeConfig, loadConfig, loadDotEnv } from './config.js';
import { createContext, SERVICE_NAME, type AppContext } from './context.js';
import { createLogger, type Logger } from './lib/logger.js';
import { createApp } from './server.js';

/** Kept in sync with package.json by hand; no build step in Phase 1. */
const VERSION = '0.1.0';

async function main(): Promise<void> {
  loadDotEnv();

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`${SERVICE_NAME}: ${message}\n`);
    process.exit(1);
  }

  const logger = createLogger({
    level: config.log.level,
    bindings: { service: SERVICE_NAME, version: VERSION },
  });

  const context = createContext({ config, version: VERSION, logger });
  const app = createApp({ context });
  const server = createServer(app);

  // Streaming responses must not be cut off by Node's default timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 72_000;

  await listen(server, config.server.port, config.server.host, logger);

  logger.info('configuration', describeConfig(config));
  await reportStartupDiagnostics(context);

  installShutdownHandlers(server, context, logger);
}

async function listen(server: Server, port: number, host: string, logger: Logger): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${port} on ${host} is already in use`)
          : error,
      );
    };

    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  logger.info('listening', { url: `http://${host}:${boundPort}`, sources: 'see GET /' });
}

/** A missing ffmpeg is fatal for audio but must not stop the server booting. */
async function reportStartupDiagnostics(context: AppContext): Promise<void> {
  const report = await context.health.report({ refresh: true });

  if (report.status === 'ok') {
    context.logger.info('dependencies ready', {
      ffmpeg: report.checks['ffmpeg']?.version ?? 'unknown',
      sources: context.sources.names.join(','),
    });
    return;
  }

  for (const [name, check] of Object.entries(report.checks)) {
    if (check.available) continue;
    const message = check.reason ?? 'unavailable';
    if (check.required) context.logger.error(`required dependency unavailable: ${name}`, { reason: message });
    else context.logger.warn(`source unavailable: ${name}`, { reason: message });
  }
}

function installShutdownHandlers(server: Server, context: AppContext, logger: Logger): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });

    const forceExit = setTimeout(() => {
      logger.warn('forcing exit after shutdown timeout', { timeoutMs: context.config.server.shutdownTimeoutMs });
      process.exit(1);
    }, context.config.server.shutdownTimeoutMs);
    forceExit.unref();

    void (async () => {
      // Stop accepting new work, then kill every encoder still running.
      await closeServer(server);
      await context.pipeline.closeAll('server-shutdown');
      clearTimeout(forceExit);
      logger.info('shutdown complete');
      process.exit(0);
    })().catch((error: unknown) => {
      logger.error('shutdown failed', { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });

  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { reason: error.message, stack: error.stack });
    shutdown('uncaughtException');
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Idle keep-alive sockets would otherwise hold the close open.
    server.closeIdleConnections?.();
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${SERVICE_NAME}: fatal error during startup: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exit(1);
});