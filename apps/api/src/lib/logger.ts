import { pino, type LoggerOptions } from 'pino';
import { env } from '../config/env.js';

/** Keys whose values must never reach the logs. */
const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  'refreshToken',
  'accessTokenEnc',
  'refreshTokenEnc',
  'exactLat',
  'exactLng',
  'ANTHROPIC_API_KEY',
];

const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: 'doggystyle-api', role: env.ROLE },
  formatters: {
    level: (label) => ({ level: label }),
  },
};

const usePretty = env.LOG_PRETTY && !env.isProd && !env.isTest;

/**
 * Pino options to pass directly to `Fastify({ logger: loggerOptions })`.
 *
 * Using the `logger` option (rather than `loggerInstance`) keeps the Fastify
 * instance typed with the default `FastifyBaseLogger`, which means all
 * `FastifyPluginAsync` plugin signatures remain compatible without casts.
 */
export const loggerOptions: LoggerOptions = usePretty
  ? {
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
      },
    }
  : baseOptions;

/** A standalone pino logger for use outside the Fastify request context (e.g. migrations, jobs). */
export const logger = pino(loggerOptions);

export type Logger = typeof logger;
