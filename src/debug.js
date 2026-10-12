// Debug overlay

const counts = { inflight: 0, bytes: 0, requests: 0, lastMs: 0 };

function started() {
  counts.inflight++;
  counts.requests++;
  return Date.now();
}


function finished(startedAt, bytes) {
  counts.inflight--;
  counts.bytes += bytes;
  counts.lastMs = Date.now() - startedAt;
}

function snapshot() {
  return {
    inflight: counts.inflight,
    bytes: counts.bytes,
    requests: counts.requests,
    lastMs: counts.lastMs,
  };
}

module.exports = { started, finished, snapshot };