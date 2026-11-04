import { AppError } from '../errors.mjs';

const DENIED = 'Authorization failed. Please check your credentials or token.';
const UNAVAILABLE = 'The authorization service is unavailable. Please try again later.';

/**
 * Verifies the caller's Authorization header against the authorization service:
 * the call must come back 200 with `authenticated` and a `principal`.
 */
export function createAuthorizer(config, logger, fetchFn = fetch) {
  return async (req, _res, next) => {
    const token = req.headers.authorization;
    const sender = req.body?.sender || 'unknown';
    const deny = (reason) => {
      logger.warn('auth.denied', { path: req.path, sender, reason });
      next(new AppError(401, DENIED));
    };
    const unavailable = (detail) => {
      logger.error('auth.unavailable', { path: req.path, detail });
      next(new AppError(503, UNAVAILABLE));
    };

    if (!token) return deny('no Authorization header');

    try {
      const response = await fetchFn(config.AUTH_URL, {
        method: 'GET',
        headers: { Authorization: token },
        signal: AbortSignal.timeout(config.AUTH_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) return deny(`rejected with ${response.status}`);
      if (response.status !== 200) return unavailable(`authorization service answered ${response.status}`);

      const result = await response.json().catch(() => null);
      if (!result?.authenticated || !result?.principal) return deny('token is not authenticated');
      next();
    } catch (error) {
      unavailable(error.message);
    }
  };
}
