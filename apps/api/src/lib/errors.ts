/**
 * Application error taxonomy. Routes throw these; the global error handler
 * converts them into a stable JSON envelope with a request id.
 *
 * Note the deliberate use of 404 for resources the actor is not allowed to see —
 * returning 403 would confirm that the id exists (an enumeration oracle).
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly expose = true,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);

export const unauthorized = (message = 'You need to sign in to do that.') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have permission to do that.') => new AppError(403, 'forbidden', message);

/** Use for anything the actor may not see — do not leak existence. */
export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);

export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'unprocessable', message, details);

export const tooManyRequests = (message = 'Too many requests. Please slow down.', details?: unknown) =>
  new AppError(429, 'rate_limited', message, details);

export const payloadTooLarge = (message: string) => new AppError(413, 'payload_too_large', message);

export const internal = (message = 'Something went wrong.') => new AppError(500, 'internal_error', message, undefined, false);

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
