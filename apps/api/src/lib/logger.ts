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

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: 'doggystyle-api', role: env.ROLE },
  formatters: {
    level: (label) => ({ level: label }),
  },
};

const usePretty = env.LOG_PRETTY && !env.isProd && !env.isTest;

export const logger = usePretty
  ? pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
      },
    })
  : pino(options);

export type Logger = typeof logger;
