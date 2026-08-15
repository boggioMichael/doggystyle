import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { authPlugin } from './plugins/auth.js';
import { contextPlugin } from './plugins/context.js';
import { errorHandlerPlugin, securityHeadersPlugin } from './plugins/security.js';

import { registerAdminRoutes } from './modules/admin/routes.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerChatRoutes } from './modules/chat/routes.js';
import { registerConnectionRoutes } from './modules/connections/routes.js';
import { registerDogRoutes } from './modules/dogs/routes.js';
import { registerHealthRoutes } from './modules/health/routes.js';
import { registerMatchingRoutes } from './modules/matching/routes.js';
import { registerMediaRoutes } from './modules/media/routes.js';
import { registerMeetupRoutes } from './modules/meetups/routes.js';
import { registerMessagingRoutes } from './modules/messaging/routes.js';
import { registerModerationRoutes } from './modules/moderation/routes.js';
import { registerSocialRoutes } from './modules/social/routes.js';
import { registerUserRoutes } from './modules/users/routes.js';

// Return type is inferred: the pino loggerInstance narrows the Fastify generics,
// and forcing the default FastifyInstance shape back on it fails to typecheck.
export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: true,
    trustProxy: true,
    bodyLimit: 1024 * 1024, // 1 MB for JSON; uploads go through multipart
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  // Applied directly rather than via app.register(): register() creates an
  // encapsulated child context, and decorators/hooks added inside it would not
  // be visible to sibling scopes — routes would lose req.requireUser().
  await contextPlugin(app, {});
  await securityHeadersPlugin(app, {});
  await errorHandlerPlugin(app, {});

  await app.register(fastifyCookie, { secret: env.SESSION_SECRET });
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: env.maxUploadBytes,
      files: env.MAX_FILES_PER_REQUEST,
      fields: 20,
      fieldSize: 100_000,
    },
  });

  await authPlugin(app, {});

  await app.register(
    async (api) => {
      await registerHealthRoutes(api);
      await registerAuthRoutes(api);
      await registerUserRoutes(api);
      await registerDogRoutes(api);
      await registerMediaRoutes(api);
      await registerSocialRoutes(api);
      await registerChatRoutes(api);
      await registerMatchingRoutes(api);
      await registerConnectionRoutes(api);
      await registerMessagingRoutes(api);
      await registerMeetupRoutes(api);
      await registerModerationRoutes(api);
      await registerAdminRoutes(api);
    },
    { prefix: '/api' },
  );

  // Optionally serve the built SPA from the same origin, which removes CORS
  // entirely and lets session cookies stay SameSite=Lax.
  if (env.SERVE_WEB) {
    if (!existsSync(path.join(env.webDistDir, 'index.html'))) {
      app.log.warn(
        { dir: env.webDistDir },
        'SERVE_WEB is on but no built web app was found — run `npm run build --workspace @doggystyle/web`',
      );
    } else {
      await app.register(fastifyStatic, {
        root: env.webDistDir,
        prefix: '/',
        index: ['index.html'],
        // Hashed asset filenames can be cached hard; index.html must not be.
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html')) res.setHeader('cache-control', 'no-cache');
          else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('cache-control', 'public, max-age=31536000, immutable');
          }
        },
      });

      // Client-side routing fallback (never for /api/*).
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) {
          reply.status(404).send({
            error: { code: 'not_found', message: 'No such endpoint.', requestId: req.requestId },
          });
          return;
        }
        reply.header('cache-control', 'no-cache');
        return reply.sendFile('index.html');
      });
    }
  }

  return app;
}
