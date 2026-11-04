import { Router } from 'express';

/** `/send-email/v3` is the current route; the older versions and the paths used by earlier callers stay mounted. */
export const SEND_PATHS = ['/send-email/v3', '/send-email/v2', '/send-email/v1', '/send-mail/v2', '/send-mailx'];

export function createMailRouter(controller, ...middleware) {
  const router = Router();
  for (const path of SEND_PATHS) router.post(path, ...middleware, controller.send);
  return router;
}
