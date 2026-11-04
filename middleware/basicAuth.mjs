import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.mjs';

const digest = (value) => createHash('sha256').update(value).digest();

/** Enforced only when NOTIFICATION_EMAIL_USERNAME / NOTIFICATION_EMAIL_PASSWORD are configured. */
export function basicAuth(config) {
  const { NOTIFICATION_EMAIL_USERNAME: username, NOTIFICATION_EMAIL_PASSWORD: password } = config;
  if (!username || !password) return (_req, _res, next) => next();

  const expected = digest(`${username}:${password}`);
  return (req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    const supplied = scheme?.toLowerCase() === 'basic' && encoded ? Buffer.from(encoded, 'base64').toString() : '';
    if (!timingSafeEqual(digest(supplied), expected)) {
      res.set('WWW-Authenticate', 'Basic realm="notification-dispatcher"');
      return next(new AppError(401, 'Authorization failed. Please check your credentials or token.'));
    }
    next();
  };
}
