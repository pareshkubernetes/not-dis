import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.mjs';
import { loadConfig } from '../config.mjs';
import { createLogger } from '../logger.mjs';
import { base64Lines } from '../services/mime.mjs';
import { collectRecipients, planBatches } from '../services/recipients.mjs';

function startSmtp({ failAttempts = [] } = {}) {
  const state = { messages: [], connections: 0, attempts: 0 };
  const server = net.createServer((socket) => {
    state.connections += 1;
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let from = '';
    let rcpts = [];
    const reply = (line) => socket.write(`${line}\r\n`);
    reply('220 test ESMTP');

    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const raw = buffer.slice(0, end).replace(/\r\n\.\./g, '\r\n.');
          buffer = buffer.slice(end + 5);
          inData = false;
          const attempt = state.attempts++;
          if (failAttempts.includes(attempt)) reply('552 mailbox full');
          else {
            state.messages.push({ from, rcpts, raw });
            reply('250 queued');
          }
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^EHLO/i.test(line)) socket.write('250-test\r\n250-SIZE 26214400\r\n250 8BITMIME\r\n');
        else if (/^MAIL FROM:/i.test(line)) {
          from = line.match(/<(.*)>/)[1];
          rcpts = [];
          reply('250 ok');
        } else if (/^RCPT TO:/i.test(line)) {
          rcpts.push(line.match(/<(.*)>/)[1]);
          reply('250 ok');
        } else if (/^DATA/i.test(line)) {
          inData = true;
          reply('354 go');
        } else if (/^QUIT/i.test(line)) {
          reply('221 bye');
          socket.end();
        } else reply('500 unknown');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })),
  );
}

function startAuth() {
  const state = { calls: 0 };
  const server = http.createServer((req, res) => {
    state.calls += 1;
    const ok = req.headers.authorization === 'Bearer good';
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { authenticated: true, principal: { name: 'pp58386' } } : { authenticated: false }));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/authorize` }),
    ),
  );
}

describe('notification dispatcher', () => {
  let smtp;
  let auth;
  let servers = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    servers = [];
  });

  const build = async (smtpOptions = {}, env = {}) => {
    smtp = await startSmtp(smtpOptions);
    auth = await startAuth();
    servers.push(smtp.server, auth.server);
    const config = loadConfig({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_STARTTLS: 'false',
      AUTH_URL: auth.url,
      NOTIFICATION_SENDER: 'noreply@example.com',
      LOG_LEVEL: 'silent',
      ...env,
    });
    const agent = request(createApp(config, createLogger('silent')));
    return {
      post: (path) => agent.post(path).set('Authorization', 'Bearer good'),
      get: (path) => agent.get(path),
      anon: agent,
    };
  };

  const fileOf = (bytes) => randomBytes(bytes);
  const attach = (data, filename = 'test_5mb_file.dat') => ({ filename, encoding: 'base64', content: data.toString('base64') });

  it('splits, validates and de-duplicates recipients, then fills batches in order', () => {
    const bcc = Array.from({ length: 250 }, (_, i) => `user${i}@example.com`).join(';');
    const recipients = collectRecipients({ to: 'A@example.com, a@example.com', cc: 'b@example.com', bcc });
    expect(recipients.to).toEqual(['A@example.com']);
    expect(planBatches(recipients, 100).map((b) => b.to.length + b.cc.length + b.bcc.length)).toEqual([100, 100, 52]);
    expect(() => collectRecipients({ to: 'not-an-address' })).toThrow('Receiver email address is not valid');
  });

  it('answers /send-email/v3 with the documented request and response shape', async () => {
    const api = await build();
    const data = fileOf(3 * 1024 * 1024 + 786_432); // 3.75 MB of file data, as in the 5 MB base64 test
    const res = await api.post('/send-email/v3').send({
      sender: 'noreply@citi.com',
      receiver: 'pp58386@citi.com',
      receiverName: 'Paresh',
      cc: 'pp58386@citi.com',
      bcc: '',
      subject: 'Test Email with 5MB Attachment',
      emailMessage: 'TEST : Your Orion self-service request has been approved. ',
      attachedFiles: [attach(data)],
    });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual([
      'apiEndpoint', 'emailSender', 'emailReceiver', 'emailCC', 'emailBCC',
      'emailSubject', 'emailInHtml', 'emailSendResponse', 'emailSuccess', 'batchResults',
    ]);
    expect(res.body).toMatchObject({
      apiEndpoint: '/send-email/v3',
      emailSender: 'noreply@citi.com',
      emailReceiver: 'pp58386@citi.com',
      emailCC: 'pp58386@citi.com',
      emailBCC: '',
      emailSubject: 'Test Email with 5MB Attachment',
      emailInHtml: false,
      emailSuccess: true,
    });
    expect(res.body.emailSendResponse).toMatch(
      /^All email batches processed successfully\. \[Payload Breakdown: Body: 0\.00MB, Attachments: 3\.75MB, Total Message MIME: 5\.1\dMB\]$/,
    );
    expect(res.body.batchResults).toHaveLength(1);
    expect(res.body.batchResults[0]).toMatchObject({
      apiEndpoint: '/send-email/v3',
      emailReceiver: 'pp58386@citi.com',
      emailCC: '',
      emailBCC: '',
      emailSuccess: true,
    });
    expect(res.body.batchResults[0].emailSendResponse).toMatch(/^Email batch sent successfully\. \[Payload Breakdown:/);

    const [{ raw, rcpts }] = smtp.state.messages;
    expect(rcpts).toEqual(['pp58386@citi.com']);
    expect(raw).toContain('Content-Type: application/octet-stream; name="test_5mb_file.dat"');
    expect(raw).toContain(base64Lines(data));
  });

  it('keeps quotes, $, backticks and unicode in an HTML body intact and bcc out of the headers', async () => {
    const api = await build();
    const html = '<head><style>.a{color:blue}</style></head><body><h2 class="a">Price: $5 `ok` “quoted”</h2></body>';
    const res = await api.post('/send-email/v3').send({
      sender: 'noreply@citi.com',
      receiver: 'to@example.com',
      bcc: 'hidden@example.com',
      subject: 'Résumé ✓',
      emailMessage: html,
      isHtml: true,
      attachedFiles: [attach(fileOf(2000), 'citi1.png')],
    });

    expect(res.status).toBe(200);
    expect(res.body.emailInHtml).toBe(true);
    const [{ raw, rcpts }] = smtp.state.messages;
    expect(rcpts).toEqual(['to@example.com', 'hidden@example.com']);
    expect(raw).not.toContain('hidden@example.com');
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
    expect(raw).toContain(base64Lines(Buffer.from(html)));
    expect(raw).toContain('Content-Type: image/png; name="citi1.png"');
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?/m);
  });

  it('delivers 250 recipients as three messages and reports each batch', async () => {
    const api = await build();
    const bcc = Array.from({ length: 250 }, (_, i) => `user${i}@example.com`).join(',');
    const res = await api.post('/send-email/v3').send({ receiver: 'to@example.com', bcc, emailMessage: 'x' });

    expect(res.status).toBe(200);
    expect(res.body.batchResults).toHaveLength(3);
    expect(res.body.batchResults.every((b) => b.emailSuccess)).toBe(true);
    expect(smtp.state.messages.map((m) => m.rcpts.length)).toEqual([100, 100, 51]);
    expect(new Set(smtp.state.messages.flatMap((m) => m.rcpts)).size).toBe(251);
    expect(smtp.state.messages[1].raw).toContain('To: undisclosed-recipients:;');
  });

  it('accepts a 12 MB attachment and refuses oversized attachments with a clear 413 before contacting SMTP', async () => {
    const api = await build();
    const twelve = fileOf(12 * 1024 * 1024);
    const ok = await api.post('/send-email/v3').send({ receiver: 'to@example.com', attachedFiles: [attach(twelve)] });
    expect(ok.status).toBe(200);
    expect(smtp.state.messages[0].raw).toContain(base64Lines(twelve));

    const connections = smtp.state.connections;
    const tooBig = await api
      .post('/send-email/v3')
      .send({ receiver: 'to@example.com', attachedFiles: [attach(fileOf(16 * 1024 * 1024))] });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.emailSuccess).toBe(false);
    expect(tooBig.body.emailSendResponse).toMatch(/attachments are too large.*limit is 15\.0 MB/);
    expect(smtp.state.connections).toBe(connections);

    const small = await build({}, { MAIL_MAX_MESSAGE_BYTES: String(1024 * 1024) });
    const overMessage = await small
      .post('/send-email/v3')
      .send({ receiver: 'to@example.com', attachedFiles: [attach(fileOf(1.2 * 1024 * 1024))] });
    expect(overMessage.status).toBe(413);
    expect(overMessage.body.emailSendResponse).toMatch(/message is too large.*limit for one message is 1\.0 MB/);
    expect(smtp.state.connections).toBe(0);
  }, 60_000);

  it('sends large messages to at most 20 recipients at a time', async () => {
    const api = await build();
    const bcc = Array.from({ length: 30 }, (_, i) => `user${i}@example.com`).join(',');
    const res = await api
      .post('/send-email/v3')
      .send({ receiver: 'to@example.com', bcc, attachedFiles: [attach(fileOf(4 * 1024 * 1024))] });

    expect(res.status).toBe(200);
    expect(res.body.batchResults).toHaveLength(2);
    expect(smtp.state.messages.map((m) => m.rcpts.length)).toEqual([20, 11]);
  }, 30_000);

  it('rejects invalid attachments and bad requests in the same response shape', async () => {
    const api = await build();
    const bad = await api
      .post('/send-email/v3')
      .send({ receiver: 'to@example.com', attachedFiles: [{ filename: 'a.pdf', encoding: 'base64', content: 'not base64!!' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.emailSendResponse).toMatch(/not valid base64/);

    const missing = await api.post('/send-email/v3').send({ subject: 'x' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ emailSendResponse: 'Receiver email address is not valid', emailSuccess: false });
    expect(missing.body).not.toHaveProperty('batchResults');

    const injected = await api.post('/send-email/v3').send({ receiver: 'to@example.com', subject: 'a\r\nBcc: evil@example.com' });
    expect(injected.status).toBe(400);

    const malformed = await api.post('/send-email/v3').set('Content-Type', 'application/json').send('{oops');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toHaveProperty('emailSuccess', false);
    expect(smtp.state.connections).toBe(0);
  });

  it('reports a failed batch but still delivers the others', async () => {
    const api = await build({ failAttempts: [1] });
    const bcc = Array.from({ length: 250 }, (_, i) => `user${i}@example.com`).join(',');
    const res = await api.post('/send-email/v3').send({ receiver: 'to@example.com', bcc, emailMessage: 'x' });

    expect(res.status).toBe(500);
    expect(res.body.emailSuccess).toBe(false);
    expect(res.body.emailSendResponse).toMatch(/Batch 2: SMTP 552/);
    expect(res.body.batchResults.map((b) => b.emailSuccess)).toEqual([true, false, true]);
    expect(res.body.batchResults[1].emailSendResponse).toMatch(/^Email batch failed: SMTP 552/);
    expect(smtp.state.messages).toHaveLength(2);
  });

  it('verifies the Authorization header with the authorization service and answers 401 as documented', async () => {
    const api = await build();
    const payload = { sender: 'noreply@citi.com', receiver: 'to@example.com', cc: 'cc@example.com', subject: 'S', emailMessage: 'x' };

    const denied = await api.anon.post('/send-email/v3').set('Authorization', 'Bearer bad').send(payload);
    expect(denied.status).toBe(401);
    expect(denied.body).toEqual({
      apiEndpoint: '/send-email/v3',
      emailSender: 'noreply@citi.com',
      emailReceiver: 'to@example.com',
      emailCC: 'cc@example.com',
      emailBCC: '',
      emailSubject: 'S',
      emailInHtml: false,
      emailSendResponse: 'Authorization failed. Please check your credentials or token.',
      emailSuccess: false,
    });
    expect((await api.anon.post('/send-email/v3').send(payload)).status).toBe(401);
    expect(auth.state.calls).toBe(1); // a missing header never reaches the authorization service
    expect((await api.post('/send-email/v3').send(payload)).status).toBe(200);

    const outage = await build({}, { AUTH_URL: 'http://127.0.0.1:1/authorize' });
    const unavailable = await outage.post('/send-email/v3').send(payload);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.emailSuccess).toBe(false);
    expect(smtp.state.connections).toBe(0);
  });

  it('treats every unexpected authorization-service answer safely', async () => {
    const reply = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    const cases = [
      ['authenticated without a principal', reply(200, { authenticated: true }), 401],
      ['not authenticated', reply(200, { authenticated: false, principal: { name: 'x' } }), 401],
      ['body that is not JSON', reply(200, 'oops'), 401],
      ['403 from the service', reply(403, {}), 401],
      ['500 from the service', reply(500, {}), 503],
      ['connection failure', async () => { throw new Error('ECONNREFUSED'); }, 503],
    ];
    const config = loadConfig({ SMTP_HOST: '127.0.0.1', LOG_LEVEL: 'silent' });
    for (const [name, fetchFn, expected] of cases) {
      const app = createApp(config, createLogger('silent'), { fetchFn });
      const res = await request(app).post('/send-email/v3').set('Authorization', 'Bearer t').send({ receiver: 'a@example.com' });
      expect(res.status, name).toBe(expected);
      expect(res.body.emailSuccess, name).toBe(false);
    }
    const app = createApp(config, createLogger('silent'), { fetchFn: reply(200, { authenticated: true, principal: { name: 'x' } }) });
    const empty = await request(app).post('/send-email/v3').set('Authorization', 'Bearer t').send({});
    expect(empty.status).toBe(400);
    expect(empty.body.emailSendResponse).toBe('Data not found to send email.');
  });

  it('keeps the earlier paths working with the legacy field names', async () => {
    const api = await build();
    const res = await api.post('/send-mail/v2').send({ to: 'to@example.com', body: 'hi', subject: 'Old' });
    expect(res.status).toBe(200);
    expect(res.body.apiEndpoint).toBe('/send-mail/v2');
    expect(res.body.emailReceiver).toBe('to@example.com');
    expect((await api.get('/health')).body).toEqual({ status: 'ok' });
  });
});
