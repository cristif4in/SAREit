// Creates N accounts with 3 repositories each in a data directory, so startup
// and request cost can be measured against a realistic amount of state.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Set before requiring anything, since config.js resolves the paths once at
// load and every later read of process.env would be too late.
process.env.SAREIT_DATA = process.argv[2];
const COUNT = Number(process.argv[3] || 20);

const accounts = require(path.join(ROOT, 'src', 'accounts.js'));
const repo = require(path.join(ROOT, 'src', 'git', 'repo.js'));
const storage = require(path.join(ROOT, 'src', 'storage.js'));

const started = Date.now();
for (let i = 0; i < COUNT; i++) {
  const login = `acct${i}`;
  accounts.createUser({
    login,
    email: `${login}@example.com`,
    salt: 'ab'.repeat(16),
    passwordHash: 'cd'.repeat(64),
  });
  for (let r = 0; r < 3; r++) {
    storage.createRepository(login, {
      name: `repo${r}`,
      description: `repository ${r}`,
      isPrivate: false,
      headBranch: 'main',
    });
  }
}
accounts.closeAll();
console.log(`seeded ${COUNT} accounts, ${COUNT * 3} repositories in ${Date.now() - started}ms`);
console.log(`data dir ${process.env.SAREIT_DATA}`);
void repo;
void fs;
