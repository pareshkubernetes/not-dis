import { Router } from 'express';

/** `/send-mailx` is the original path; `/send-mail/v2` is the path workspace-mgr calls. */
export const SEND_PATHS = ['/send-mailx', '/send-mail/v2'];

export function createMailRouter(controller, ...middleware) {
  const router = Router();
  for (const path of SEND_PATHS) router.post(path, ...middleware, controller.send);
  return router;
}
