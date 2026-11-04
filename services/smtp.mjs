import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { AppError } from '../errors.mjs';

const CRLF = '\r\n';

export class SmtpError extends Error {
  constructor(reply) {
    super(`SMTP ${reply.code}: ${reply.lines.map((l) => l.slice(4)).join(' ').trim()}`);
    this.name = 'SmtpError';
    this.code = reply.code;
  }
}

/** Connection-level failures: retrying other batches against the same server is pointless. */
const fatal = (error) => Object.assign(error, { fatal: true });

const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const serverName = (config) => (net.isIP(config.SMTP_HOST) ? undefined : config.SMTP_HOST);

function armTimeout(socket, config) {
  socket.setTimeout(config.SMTP_TIMEOUT_MS, () =>
    socket.destroy(fatal(new Error('The mail server did not respond in time.'))),
  );
}

function connect(config) {
  return new Promise((resolve, reject) => {
    const secure = config.SMTP_SECURE;
    const socket = secure
      ? tls.connect({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          servername: serverName(config),
          rejectUnauthorized: config.SMTP_TLS_REJECT_UNAUTHORIZED,
        })
      : net.connect({ host: config.SMTP_HOST, port: config.SMTP_PORT });
    armTimeout(socket, config);
    socket.once(secure ? 'secureConnect' : 'connect', () => resolve(socket));
    socket.once('error', (e) => reject(fatal(e)));
  });
}

function upgrade(socket, config) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({
      socket,
      servername: serverName(config),
      rejectUnauthorized: config.SMTP_TLS_REJECT_UNAUTHORIZED,
    });
    armTimeout(secured, config);
    secured.once('secureConnect', () => resolve(secured));
    secured.once('error', (e) => reject(fatal(e)));
  });
}

/** Turns the socket's byte stream into whole SMTP replies (multi-line replies included). */
function replyReader(socket) {
  let buffer = '';
  let lines = [];
  let failure = null;
  const replies = [];
  const waiting = [];

  const settle = () => {
    while (waiting.length) {
      if (replies.length) waiting.shift().resolve(replies.shift());
      else if (failure) waiting.shift().reject(failure);
      else break;
    }
  };
  const onData = (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      lines.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        replies.push({ code: Number(line.slice(0, 3)), lines });
        lines = [];
      }
    }
    settle();
  };
  const fail = (error) => {
    failure ??= fatal(error);
    settle();
  };

  socket.setEncoding('utf8');
  socket.on('data', onData);
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('The mail server closed the connection unexpectedly.')));

  return {
    next: () => new Promise((resolve, reject) => { waiting.push({ resolve, reject }); settle(); }),
    stop: () => socket.off('data', onData),
  };
}

/** Delivers one message to one set of envelope recipients. Returns who was accepted and who was refused. */
export async function deliver(config, { from, recipients, message }) {
  let socket = await connect(config);
  let reader = replyReader(socket);
  let encrypted = config.SMTP_SECURE;
  let finished = false;

  const expect = async (...codes) => {
    const reply = await reader.next();
    if (!codes.includes(reply.code)) throw new SmtpError(reply);
    return reply;
  };
  const command = async (line, ...codes) => {
    socket.write(line + CRLF);
    return expect(...codes);
  };
  const ehlo = async () => {
    const reply = await command(`EHLO ${os.hostname().replace(/[^\w.-]/g, '') || 'localhost'}`, 250);
    return new Map(
      reply.lines.slice(1).map((l) => {
        const [key, ...args] = l.slice(4).trim().split(/\s+/);
        return [key.toUpperCase(), args];
      }),
    );
  };

  try {
    await expect(220);
    let capabilities = await ehlo();

    if (!config.SMTP_SECURE && config.SMTP_STARTTLS && capabilities.has('STARTTLS')) {
      await command('STARTTLS', 220);
      reader.stop();
      socket = await upgrade(socket, config);
      reader = replyReader(socket);
      encrypted = true;
      capabilities = await ehlo();
    }

    if (config.SMTP_USER) {
      if (!encrypted) throw new Error('Refusing to send SMTP credentials over an unencrypted connection.');
      if (!capabilities.has('AUTH')) throw new Error('The mail server does not offer authentication.');
      const token = Buffer.from(`\0${config.SMTP_USER}\0${config.SMTP_PASSWORD}`).toString('base64');
      await command(`AUTH PLAIN ${token}`, 235);
    }

    const declared = Number(capabilities.get('SIZE')?.[0] ?? 0);
    if (declared && message.length > declared) {
      throw new AppError(
        413,
        `The mail server accepts messages up to ${megabytes(declared)}; this one is ${megabytes(message.length)}.`,
      );
    }
    await command(`MAIL FROM:<${from}>${declared ? ` SIZE=${message.length}` : ''}`, 250);

    const accepted = [];
    const rejected = [];
    for (const address of recipients) {
      socket.write(`RCPT TO:<${address}>${CRLF}`);
      const reply = await reader.next();
      if (reply.code === 250 || reply.code === 251) accepted.push(address);
      else rejected.push({ address, reason: new SmtpError(reply).message });
    }
    if (accepted.length === 0) {
      throw new Error(`The mail server rejected every recipient (${rejected[0].reason}).`);
    }

    await command('DATA', 354);
    const stuffed = message.toString('latin1').replace(/(^|\r\n)\./g, '$1..');
    socket.write(Buffer.from(stuffed.endsWith(CRLF) ? stuffed : stuffed + CRLF, 'latin1'));
    await command('.', 250);

    finished = true;
    socket.end(`QUIT${CRLF}`);
    return { accepted, rejected };
  } finally {
    if (!finished) socket.destroy();
  }
}
