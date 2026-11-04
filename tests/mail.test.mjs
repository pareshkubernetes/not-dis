import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

describe('notification dispatcher', () => {
  let dir;
  let smtp;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'dispatcher-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));
  afterEach(() => new Promise((resolve) => (smtp ? smtp.server.close(resolve) : resolve())));

  const build = async (smtpOptions = {}, env = {}) => {
    smtp = await startSmtp(smtpOptions);
    const config = loadConfig({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_STARTTLS: 'false',
      NOTIFICATION_SENDER: 'noreply@example.com',
      MAIL_ATTACHMENT_DIR: dir,
      LOG_LEVEL: 'silent',
      ...env,
    });
    return request(createApp(config, createLogger('silent')));
  };

  it('splits, validates and de-duplicates recipients, then fills batches in order', () => {
    const bcc = Array.from({ length: 250 }, (_, i) => `user${i}@example.com`).join(';');
    const recipients = collectRecipients({ to: 'A@example.com, a@example.com', cc: 'b@example.com', bcc });
    expect(recipients.to).toEqual(['A@example.com']);
    expect(planBatches(recipients, 100).map((b) => b.to.length + b.cc.length + b.bcc.length)).toEqual([100, 100, 52]);
    expect(() => collectRecipients({ to: 'not-an-address' })).toThrow(/Invalid recipient/);
  });

  it('sends on /send-mailx with the original response contract and keeps bcc out of the headers', async () => {
    const api = await build();
    const res = await api
      .post('/send-mailx')
      .send({ receiver: 'to@example.com', cc: 'cc@example.com', bcc: 'hidden@example.com', subject: 'Hello', body: 'Hi' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      apiEndpoint: '/send-mailx',
      emailReceiver: 'to@example.com',
      emailSubject: 'Hello',
      emailCC: 'cc@example.com',
      emailBCC: 'hidden@example.com',
      emailSendResponse: 'Email sent successfully.',
      emailSuccess: true,
    });
    const [message] = smtp.state.messages;
    expect(message.rcpts).toEqual(['to@example.com', 'cc@example.com', 'hidden@example.com']);
    expect(message.raw).toMatch(/^To: to@example\.com$/m);
    expect(message.raw).not.toContain('hidden@example.com');
  });

  it('accepts the /send-mail/v2 payload and keeps quotes, $ and unicode in an HTML body intact', async () => {
    const api = await build();
    const html = '<p style="color:red">Price: $5 `ok` “quoted”</p>';
    const res = await api.post('/send-mail/v2').send({
      sender: 'sender@example.com',
      receiver: 'to@example.com',
      receiverName: 'TO',
      cc: '',
      bcc: '',
      subject: 'Résumé ✓',
      emailMessage: html,
      isHtml: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.apiEndpoint).toBe('/send-mail/v2');
    const [{ raw, from }] = smtp.state.messages;
    expect(from).toBe('sender@example.com');
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
    expect(raw).toContain(base64Lines(Buffer.from(html)));
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?/m);
  });

  it('delivers 250 recipients as three messages, each recipient exactly once', async () => {
    const api = await build();
    const bcc = Array.from({ length: 250 }, (_, i) => `user${i}@example.com`);
    const res = await api.post('/send-mailx').send({ receiver: 'to@example.com', bcc: bcc.join(','), body: 'x' });

    expect(res.body.emailSendResponse).toBe('Email sent successfully in batches.');
    expect(smtp.state.messages.map((m) => m.rcpts.length)).toEqual([100, 100, 51]);
    const delivered = smtp.state.messages.flatMap((m) => m.rcpts);
    expect(new Set(delivered).size).toBe(251);
    expect(smtp.state.messages[1].raw).toContain('To: undisclosed-recipients:;');
  });

  it('attaches files byte for byte, including names with spaces', async () => {
    const api = await build();
    const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    await writeFile(path.join(dir, 'monthly report.pdf'), data);

    const res = await api
      .post('/send-mailx')
      .send({ receiver: 'to@example.com', body: 'see attached', attachments: ['monthly report.pdf'] });

    expect(res.status).toBe(200);
    const { raw } = smtp.state.messages[0];
    expect(raw).toContain('Content-Type: application/pdf; name="monthly report.pdf"');
    expect(raw).toContain(base64Lines(data));
  });

  it('refuses attachments outside the attachment directory without touching SMTP', async () => {
    const api = await build();
    for (const attachment of ['../secret.txt', path.join(os.tmpdir(), 'anything.txt'), 'missing.txt']) {
      const res = await api.post('/send-mailx').send({ receiver: 'to@example.com', attachments: [attachment] });
      expect(res.status).toBe(400);
      expect(res.body.emailSuccess).toBe(false);
      expect(res.body.emailSendResponse).toMatch(/^Attachment not found/);
    }
    expect(smtp.state.connections).toBe(0);
  });

  it('rejects an oversized message up front with a clear 413', async () => {
    const api = await build({}, { MAIL_MAX_MESSAGE_BYTES: String(1024 * 1024) });
    await writeFile(path.join(dir, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 1));

    const res = await api.post('/send-mailx').send({ receiver: 'to@example.com', attachments: ['big.bin'] });

    expect(res.status).toBe(413);
    expect(res.body.emailSuccess).toBe(false);
    expect(res.body.emailSendResponse).toMatch(/too large.*limit for one message is 1\.0 MB/);
    expect(smtp.state.connections).toBe(0);
  });

  it('answers bad requests with the same response shape', async () => {
    const api = await build();
    const missing = await api.post('/send-mailx').send({ subject: 'x' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ emailSendResponse: 'No recipients provided.', emailSuccess: false });

    const injected = await api.post('/send-mailx').send({ receiver: 'to@example.com', subject: 'a\r\nBcc: evil@example.com' });
    expect(injected.status).toBe(400);

    const malformed = await api.post('/send-mailx').set('Content-Type', 'application/json').send('{oops');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toHaveProperty('emailSuccess', false);
    expect(smtp.state.connections).toBe(0);
  });

  it('reports a failed batch but still delivers the others', async () => {
    const api = await build({ failAttempts: [1] });
    const bcc = Array.from({ length: 250 }, (_, i) => `user${i}@example.com`).join(',');
    const res = await api.post('/send-mailx').send({ receiver: 'to@example.com', bcc, body: 'x' });

    expect(res.status).toBe(500);
    expect(res.body.emailSuccess).toBe(false);
    expect(res.body.emailSendResponse).toMatch(/Batch 2 of 3: SMTP 552/);
    expect(smtp.state.messages).toHaveLength(2);
  });

  it('requires Basic credentials when they are configured', async () => {
    const api = await build({}, { NOTIFICATION_EMAIL_USERNAME: 'mailer', NOTIFICATION_EMAIL_PASSWORD: 's3cret' });
    const payload = { receiver: 'to@example.com', body: 'x' };

    expect((await api.post('/send-mail/v2').send(payload)).status).toBe(401);
    expect((await api.post('/send-mail/v2').auth('mailer', 'wrong').send(payload)).status).toBe(401);
    expect((await api.post('/send-mail/v2').auth('mailer', 's3cret').send(payload)).status).toBe(200);
  });
});
