const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (name) => (msg, fields = {}) => {
    if (LEVELS[name] < threshold) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: name, msg, ...fields });
    (LEVELS[name] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
