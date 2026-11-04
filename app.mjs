import express from 'express';
import { mailResponse } from './controllers/response.mjs';
import { createMailController } from './controllers/mailx.mjs';
import { basicAuth } from './middleware/basicAuth.mjs';
import { createMailRouter } from './routes/mailRoutes.mjs';
import { createMailer } from './services/mailer.mjs';

export function createApp(config, logger, mailer = createMailer(config, logger)) {
  const app = express();
  app.disable('x-powered-by');

  const controller = createMailController({ config, mailer, logger });
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.use(createMailRouter(controller, express.json({ limit: config.MAIL_BODY_LIMIT }), basicAuth(config)));

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((error, req, res, _next) => {
    let status = error.status ?? 500;
    let message = error.message;
    if (error.type === 'entity.parse.failed') {
      status = 400;
      message = 'Request body is not valid JSON.';
    } else if (error.type === 'entity.too.large') {
      status = 413;
      message = 'Request body is too large.';
    } else if (!error.status) {
      logger.error('http.unhandled', { path: req.path, error: error.message });
      message = 'Unexpected error while sending the email.';
    }
    res.status(status).json(mailResponse(req.path, req.body, config, message, false));
  });

  return app;
}
