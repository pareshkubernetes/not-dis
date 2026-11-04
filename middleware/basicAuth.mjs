import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.mjs';

const digest = (value) => createHash('sha256').update(value).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

/** Enforced only when NOTIFICATION_EMAIL_USERNAME / NOTIFICATION_EMAIL_PASSWORD are configured. */
export function basicAuth(config, logger) {
  const { NOTIFICATION_EMAIL_USERNAME: username, NOTIFICATION_EMAIL_PASSWORD: password } = config;
  if (!username || !password) return (_req, _res, next) => next();

  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme = '', encoded = ''] = header.split(' ');
    let reason = null;
    let supplied = ['', ''];

    if (!header) reason = 'no Authorization header';
    else if (scheme.toLowerCase() !== 'basic') reason = `unsupported scheme "${scheme}" (Basic is required)`;
    else {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const split = decoded.indexOf(':');
      supplied = split < 0 ? [decoded, ''] : [decoded.slice(0, split), decoded.slice(split + 1)];
      if (!same(supplied[0], username)) reason = 'username does not match';
      else if (!same(supplied[1], password)) reason = 'password does not match';
    }

    if (!reason) return next();
    logger?.warn('auth.denied', { path: req.path, reason, expectedPasswordLength: password.length, receivedPasswordLength: supplied[1].length });
    res.set('WWW-Authenticate', 'Basic realm="notification-dispatcher"');
    next(new AppError(401, 'Authorization failed. Please check your credentials or token.'));
  };
}
