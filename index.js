// SAREit entry point. One port carries the web UI and the git smart HTTP
// protocol, so a single URL is all a user needs to configure.
//
// Set SAREIT_TLS_CERT and SAREIT_TLS_KEY to serve HTTPS instead. That matters
// here: git push and clone send the account password as HTTP Basic, which
// without TLS is readable by anything on the path between the client and this
// process.

const http = require('http');
const https = require('https');
const fs = require('fs');
const { HOST, PORT } = require('./src/config');
const { createApp, reportStartupState } = require('./src/app');
const accounts = require('./src/accounts');
const catalog = require('./src/catalog');
const repo = require('./src/git/repo');

// scrypt runs on this pool. It is the deliberate cost of a password check, and
// at the default of 4 threads a handful of simultaneous sign ins would queue
// behind each other.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

reportStartupState();

const app = createApp();
const cert = process.env.SAREIT_TLS_CERT;
const key = process.env.SAREIT_TLS_KEY;
const usingTls = !!(cert && key);

const server = usingTls
  ? https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, app)
  : http.createServer(app);

// A clone of a 100MB repository can take minutes. The default 5 minute header
// timeout and 2 minute keep-alive are fine; the request timeout is not, so a
// long fetch or push is given room and the socket timeout is disabled.
server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 61000;
server.timeout = 0;

server.listen(PORT, HOST, () => {
  const scheme = usingTls ? 'https' : 'http';
  console.log(`SAREit listening on ${scheme}://${HOST}:${PORT}`);
  if (!usingTls) {
    console.log('SAREit is on plain HTTP; set SAREIT_TLS_CERT and SAREIT_TLS_KEY before using it on an untrusted network');
  }
});

server.on('error', (err) => {
  console.error(`SAREit could not bind ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Accounts hold open SQLite handles; closing them lets the WAL files be
    // checkpointed into the main file instead of being left for recovery.
    // Packfile descriptors have to go too, or the process lingers on them.
    accounts.closeAll();
    catalog.close();
    repo.closePacks();
    server.close(() => process.exit(0));
    // A client holding a connection open would otherwise keep the shutdown
    // waiting forever.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
