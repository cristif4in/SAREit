// Counts the file descriptors a process holds, by asking the OS.
//
//   node fds.js <pid>
//   node fds.js self

const fs = require('fs');

function countFds(pid) {
  if (process.platform !== 'linux') {
    // Windows exposes no cheap way to count a process's descriptors. The
    // directory handle count is a good enough proxy.
    return null;
  }
  return fs.readdirSync(`/proc/${pid}/fd`).length;
}

const target = process.argv[2] === 'self' ? process.pid : process.argv[2];

if (process.platform === 'linux') {
  console.log(`${target}: ${countFds(target)} open file descriptors`);
} else {
  console.log('fd counting needs Linux; on this platform the crash shows up as EMFILE in the server log instead');
}
