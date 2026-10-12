// SQLite, whichever runtime this is on.
//
// Node 22.5 and later expose node:sqlite. Bun has its own module at
// bun:sqlite with a close but not identical shape: the constructor is called
// Database rather than DatabaseSync, and it returns plain objects instead of
// null-prototype ones. Everything SAREit uses is the same on both, so this
// resolves the constructor once and the rest of the code does not care.
//
// If neither is present the platform is not supported and saying so plainly
// beats a confusing "Module not found" further up the stack.

let DatabaseSync;

try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (nodeErr) {
  try {
    ({ Database: DatabaseSync } = require('bun:sqlite'));
  } catch (bunErr) {
    throw new Error(
      'SAREit needs SQLite from the runtime. Run it on Node 22.5 or newer, ' +
        'or on Bun, which provides bun:sqlite.'
    );
  }
}

// node:sqlite rows are null-prototype objects. Spreading one is harmless and
// both runtimes index the same way, so callers are left as they are.
function openDatabase(file) {
  return new DatabaseSync(file);
}

module.exports = { openDatabase };
