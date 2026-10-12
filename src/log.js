// Console output for the host: timestamp, level, event, then key=value fields,
// so a running instance can be read with grep rather than by eye.
//
// info is routine and goes to stdout; the rest goes to stderr, so a supervisor
// collecting only stderr has the problems and not the running commentary.

const NAME = 'SAREit';

function fields(part) {
  if (!part) return '';
  const pairs = Object.entries(part).filter(([, value]) => value !== undefined && value !== null);
  if (!pairs.length) return '';
  return ` ${pairs
    .map(([key, value]) => `${key}=${/[\s"]/.test(String(value)) ? JSON.stringify(String(value)) : value}`)
    .join(' ')}`;
}

function emit(level, stream, event, part) {
  stream(`${new Date().toISOString()} ${level} ${NAME} ${event}${fields(part)}\n`);
}

const info = (event, part) => emit('info', console.log, event, part);
const warn = (event, part) => emit('warn', console.error, event, part);
const error = (event, part) => emit('error', console.error, event, part);
const audit = (event, part) => emit('audit', console.error, event, part);

module.exports = { info, warn, error, audit };