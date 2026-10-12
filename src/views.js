// SAREit HTML for every page.

const { MAX_REPO_BYTES, MAX_ACCOUNT_BYTES, HIGHLIGHTED_LOGINS } = require('./config');

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function hrefPath(parts) {
  return parts.map((part) => encodeURIComponent(part)).join('/');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatWhen(epochMs) {
  if (!epochMs) return 'unknown';
  const seconds = Math.floor(epochMs / 1000);
  const delta = Date.now() / 1000 - seconds;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)} minute${delta < 120 ? '' : 's'} ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} hour${delta < 7200 ? '' : 's'} ago`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)} day${delta < 172800 ? '' : 's'} ago`;
  return new Date(epochMs).toISOString().slice(0, 10);
}

function layout({ title, user, query = '', body, flash }) {
  const account = user
    ? `<span class="account">${esc(user.login)}</span>
       <form method="post" action="/logout" class="inline"><button class="linkish" type="submit">Sign out</button></form>`
    : `<a class="linkish" href="/login">Sign in</a>
       <a class="btn btn-ghost" href="/register">Sign up</a>`;

  const banner = flash
    ? `<div class="flash flash-${flash.kind}">${esc(flash.text)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | SAREit</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js"></script>
</head>
<body>
<header class="masthead">
  <div class="masthead-inner">
    <a class="logo" href="/">SAREit</a>
    <form class="search" action="/" method="get" role="search">
      <input type="search" name="q" value="${esc(query)}" placeholder="Search repositories" aria-label="Search repositories">
    </form>
    <nav class="masthead-nav">
      <button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch colour theme">Light</button>
      ${account}
    </nav>
  </div>
</header>
<main class="page">
${banner}
${body}
</main>
<footer class="colophon"><a href="https://gta.deloskiyt.pl/" rel="noopener noreferrer" target="_blank">https://gta.deloskiyt.pl/</a></footer>
<div id="Debug" hidden aria-hidden="true">
  <div class="debug-row">Response <span id="t">0ms</span></div>
  <div class="debug-row">In flight <span id="c">0</span></div>
  <div class="debug-row">Data <span id="d">0B</span></div>
</div>
</body>
</html>`;
}

function gauge(usedBytes, limitBytes, label) {
  const pct = Math.max(0, Math.min(100, Math.round((usedBytes / limitBytes) * 100)));
  return `<div class="gauge" title="${esc(`${formatBytes(usedBytes)} of ${formatBytes(limitBytes)}`)}">
  <div class="gauge-fill" style="width:${pct}%"></div>
</div>
<p class="muted small">${esc(label)}: ${esc(formatBytes(usedBytes))} of ${esc(formatBytes(limitBytes))}</p>`;
}

function repoHeader({ repo, viewer, active, ref, branchesCount, tagsCount }) {
  const base = `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const tabs = [
    ['code', 'Code', `${base}/tree/${hrefPath([ref || 'HEAD'])}`],
    ['commits', 'Commits', `${base}/commits/${hrefPath([ref || 'HEAD'])}`],
    ['branches', 'Branches', `${base}/branches`],
    ['tags', 'Tags', `${base}/tags`],
  ];
  const isOwner = viewer && viewer.login.toLowerCase() === repo.owner.toLowerCase();
  if (isOwner) tabs.push(['settings', 'Settings', `${base}/settings`]);

  const nav = tabs
    .map(([key, label, href]) => `<a class="tab${key === active ? ' tab-active' : ''}" href="${href}">${label}</a>`)
    .join('');

  const visibility = repo.private
    ? '<span class="pill pill-private">Private</span>'
    : '<span class="pill">Public</span>';

  return `<div class="repo-head">
  <div class="repo-title">
    <a class="owner" href="/${encodeURIComponent(repo.owner)}">${esc(repo.owner)}</a><span class="sep">/</span><a class="name" href="${base}">${esc(repo.name)}</a>
    ${visibility}
  </div>
  <div class="repo-meta">
    <a href="${base}/commits/${hrefPath([ref || 'HEAD'])}"><strong>${branchesCount}</strong> branches</a>
    <a href="${base}/tags"><strong>${tagsCount}</strong> tags</a>
  </div>
</div>
<nav class="tabs">${nav}</nav>`;
}

function repoSidebar({ repo, sizeBytes, accountBytes, cloneUrl, defaultBranch, isOwner, importedFrom }) {
  const about = repo.description
    ? `<p>${esc(repo.description)}</p>`
    : '<p class="muted">No description yet.</p>';

  const importLine = importedFrom
    ? `<li>Imported from <span class="small">${esc(importedFrom)}</span></li>`
    : '';

  return `<aside class="sidebar">
  <h2>About</h2>
  ${about}
  <ul class="facts">
    <li><a href="/${encodeURIComponent(repo.owner)}">${esc(repo.owner)}</a></li>
    <li>Default branch <code>${esc(defaultBranch)}</code></li>
    ${importLine}
    ${isOwner ? `<li><a href="/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/settings">Settings</a></li>` : ''}
  </ul>
  <h2>Clone</h2>
  <div class="clone">
    <input type="text" readonly value="${esc(cloneUrl)}" aria-label="Clone URL" data-select-on-click>
  </div>
  <p class="muted small">git clone ${esc(cloneUrl)}</p>
  ${gauge(sizeBytes, MAX_REPO_BYTES, 'Repository')}
  ${gauge(accountBytes, MAX_ACCOUNT_BYTES, 'Account total')}
</aside>`;
}

function repoEmpty({ repo, cloneUrl }) {
  return `<div class="empty-repo">
  <h2>Quick setup</h2>
  <p>This repository is empty. Push your first commit from a local checkout:</p>
  <pre><code>git remote add sareit ${esc(cloneUrl)}
git push -u sareit main</code></pre>
  <p class="muted">git push asks for your SAREit username and password.</p>
</div>`;
}

function branchPicker({ branches, current, base }) {
  const options = branches.length
    ? branches
        .map((branch) => `<option value="${esc(branch.name)}"${branch.name === current ? ' selected' : ''}>${esc(branch.name)}</option>`)
        .join('')
    : `<option value="${esc(current)}">${esc(current)}</option>`;
  return `<form class="branch-picker" method="get" action="${base}/tree">
  <select name="ref" data-autosubmit aria-label="Branch">${options}</select>
  <noscript><button class="btn btn-ghost btn-sm" type="submit">Switch</button></noscript>
</form>`;
}

// A commit carries the person who ran git commit. The person who pushed it to
// this server is a different identity and is recorded separately, because a
// shared or work git identity makes the two differ all the time and showing
// only the author is what makes it look like the wrong account committed.
function commitRow({ commit, base }) {
  const pushed = commit.pushedBy;
  const byline = pushed
    ? `<span>committed by ${esc(commit.author.name || 'unknown')}</span><span>pushed by ${esc(pushed)}</span>`
    : `<span>committed by ${esc(commit.author.name || 'unknown')}</span>`;

  return `<li class="commit-row">
  <div class="commit-subject">
    <a href="${base}/commit/${commit.sha}">${esc(commit.subject || 'No commit message')}</a>
    ${commit.parents.length > 1 ? '<span class="pill pill-merge">merge</span>' : ''}
  </div>
  <div class="commit-meta">
    <a class="sha" href="${base}/commit/${commit.sha}">${esc(commit.sha.slice(0, 7))}</a>
    <span>${esc(formatWhen(commit.committer.when))}</span>
    ${byline}
  </div>
</li>`;
}

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|py|rb|go|rs|java|c|h|cc|cpp|hpp|cs|php|sh|bash|yml|yaml|toml|sql|html|css|scss)$/i;

function entryIcon(entry) {
  if (entry.isTree) return 'dir';
  if (entry.isSubmodule) return 'sub';
  if (/\.md$/i.test(entry.name)) return 'doc';
  if (CODE_EXT.test(entry.name)) return 'code';
  if (/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|tgz|tar|bin|woff2?)$/i.test(entry.name)) return 'binary';
  return 'file';
}

// Each entry carries the sha of the last commit that touched it, which is
// what makes the message a link to that commit. An entry with no sha is one
// the history walk could not place, and renders as plain text rather than a
// link that goes nowhere.
function blobTable({ entries, base, ref, pathSegments }) {
  const rows = entries
    .map((entry) => {
      const kind = entry.isTree ? 'tree' : 'blob';
      const link = `${base}/${kind}/${hrefPath([ref, ...pathSegments, entry.name])}`;
      const last = entry.sha
        ? `<a href="${base}/commit/${entry.sha}" title="${esc(entry.subject || '')}">${esc(entry.subject || 'No commit message')}</a>`
        : '<span class="muted">unrecorded</span>';
      return `<tr>
  <td class="icon"><span class="ico ico-${entryIcon(entry)}"></span></td>
  <td class="name"><a href="${link}">${esc(entry.name)}</a></td>
  <td class="msg">${last}</td>
</tr>`;
    })
    .join('');
  return `<table class="blob-table">
  <thead><tr><th class="icon"></th><th>Name</th><th>Last commit</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

// Cards owned by a highlighted account carry a class, which is what the
// stylesheet animates. The decision is made here so the view stays free of
// any account names.
function highlighted(owner) {
  return HIGHLIGHTED_LOGINS.includes(String(owner).toLowerCase()) ? ' repo-card-highlight' : '';
}

function dashboard({ user, repos, query, flash }) {
  const create = user
    ? '<a class="btn" href="/new">New repository</a>'
    : '<a class="btn" href="/login">Sign in to create a repository</a>';

  const cards = repos.length
    ? repos
        .map(
          (repo) => `<li class="repo-card${highlighted(repo.owner)}">
  <div class="repo-card-head">
    <a class="repo-card-name" href="/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}"><strong>${esc(repo.owner)}</strong>/<strong>${esc(repo.name)}</strong></a>
    ${repo.private ? '<span class="pill pill-private">Private</span>' : ''}
  </div>
  <p class="muted">${esc(repo.description || 'No description')}</p>
  <p class="muted small">${esc(repo.owner)}</p>
</li>`
        )
        .join('')
    : `<li class="repo-card muted">${query ? 'No repositories match that search.' : 'No repositories yet.'}</li>`;

  return layout({
    title: user ? user.login : 'Home',
    user,
    query,
    flash,
    body: `<div class="page-head">
  <h1>${user ? `${esc(user.login)}'s repositories` : 'Repositories'}</h1>
  ${create}
</div>
<ul class="repo-list">${cards}</ul>`,
  });
}

function newRepoPage({ user, error, values, csrf }) {
  const importUrl = values.import || '';
  const token = csrf ? `<input type="hidden" name="csrf" value="${esc(csrf)}">` : '';
  return layout({
    title: 'New repository',
    user,
    body: `<div class="narrow">
  <h1>Create a new repository</h1>
  ${error ? `<div class="flash flash-error">${esc(error)}</div>` : ''}
  <form method="post" action="/new" class="stack">
    ${token}
    <label>Owner
      <input type="text" name="owner" value="${esc(values.owner || user.login)}" readonly>
    </label>
    <label>Repository name
      <input type="text" name="name" value="${esc(values.name || '')}" required pattern="[A-Za-z0-9._-]{1,64}" placeholder="my-project">
    </label>
    <label>Description
      <input type="text" name="description" value="${esc(values.description || '')}" maxlength="180" placeholder="Short description">
    </label>
    <label class="check"><input type="checkbox" name="private" value="1"${values.private ? ' checked' : ''}> Private repository</label>
    <div class="actions">
      <button class="btn" type="submit">Create repository</button>
      <a class="linkish" href="/">Cancel</a>
    </div>
  </form>

  <section class="panel">
    <h2>Import an existing project</h2>
    <p class="muted">Copies a git remote into this account. Commit messages, authors, dates, tags and branches are copied as they are, and nothing here rewrites them afterwards.</p>
    <form method="post" action="/new" class="stack">
      ${token}
      <label>Repository name
        <input type="text" name="name" value="${esc(values.name || '')}" required pattern="[A-Za-z0-9._-]{1,64}" placeholder="my-project">
      </label>
      <label>Git URL
        <input type="text" name="import" value="${esc(importUrl)}" placeholder="https://github.com/owner/project.git">
      </label>
      <label>Description
        <input type="text" name="description" value="${esc(values.description || '')}" maxlength="180">
      </label>
      <label class="check"><input type="checkbox" name="private" value="1"${values.private ? ' checked' : ''}> Private repository</label>
      <div class="actions">
        <button class="btn" type="submit">Import</button>
        <span class="muted small">The copy runs on the server and the next page shows how far it has got.</span>
      </div>
    </form>
  </section>
</div>`,
  });
}

// The bar is drawn from the job as it stands, so a reload mid-copy is right and
// a copy that finished before the page was asked for shows its link at once.
// public/app.js then follows the status, which is the same job read again.
function importPage({ user, job, statusUrl }) {
  const base = `/${encodeURIComponent(job.owner)}/${encodeURIComponent(job.name)}`;
  const percent = Math.max(0, Math.min(100, job.percent));
  const moving = !job.reported;
  const detail = job.detail ? ` <span class="muted small">${esc(job.detail)}</span>` : '';

  return layout({
    title: `Importing ${job.name}`,
    user,
    body: `<div class="narrow">
  <h1>Importing ${esc(job.owner)}/${esc(job.name)}</h1>
  <section class="panel" data-import-status="${esc(statusUrl)}">
    <p class="muted">From <code>${esc(job.source)}</code></p>
    <div class="import-bar" role="progressbar" aria-label="Import progress" aria-valuemin="0" aria-valuemax="100"${moving ? '' : ` aria-valuenow="${percent}"`}>
      <div class="import-fill" data-import-bar style="width:${moving ? 30 : percent}%"${moving ? ' data-moving' : ''}></div>
    </div>
    <p class="import-line"><span data-import-phase>${esc(job.phase)}</span>${detail}</p>
    ${
      job.state === 'done'
        ? `<div class="flash flash-ok">Imported. <a href="${base}">Open ${esc(job.name)}</a>.</div>`
        : `<noscript><p class="muted small">This page does not update without JavaScript. Reload it to see where the copy has got.</p></noscript>`
    }
  </section>
  <p><a class="linkish" href="/new">Start another import</a></p>
</div>`,
  });
}

function authPage({ mode, error, values, next, csrf }) {
  const isRegister = mode === 'register';
  const login = values?.login || '';
  const email = values?.email || '';
  const token = csrf ? `<input type="hidden" name="csrf" value="${esc(csrf)}">` : '';
  return layout({
    title: isRegister ? 'Sign up' : 'Sign in',
    user: null,
    body: `<div class="narrow">
  <h1>${isRegister ? 'Create your account' : 'Sign in to SAREit'}</h1>
  ${error ? `<div class="flash flash-error">${esc(error)}</div>` : ''}
  <form method="post" action="/${mode}" class="stack">
    <input type="hidden" name="next" value="${esc(next || '/')}">
    ${token}
    <label>Username
      <input type="text" name="login" value="${esc(login)}" required autocomplete="username" pattern="[A-Za-z0-9][A-Za-z0-9-]{0,38}">
    </label>
    ${
      isRegister
        ? `<label>Email
      <input type="text" name="email" value="${esc(email)}" autocomplete="email" placeholder="you@example.com">
    </label>`
        : ''
    }
    <label>Password
      <input type="password" name="password" required minlength="8" autocomplete="${isRegister ? 'new-password' : 'current-password'}">
    </label>
    <div class="actions">
      <button class="btn" type="submit">${isRegister ? 'Sign up' : 'Sign in'}</button>
      ${isRegister ? '<a class="linkish" href="/login">Already have an account?</a>' : '<a class="linkish" href="/register">Need an account?</a>'}
    </div>
  </form>
</div>`,
  });
}

function profilePage({ profile, repos, accountBytes, isSelf, user, flash }) {
  const cards = repos.length
    ? repos
        .map(
          (repo) => `<li class="repo-card${highlighted(repo.owner)}">
  <div class="repo-card-head">
    <a class="repo-card-name" href="/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}"><strong>${esc(repo.owner)}</strong>/<strong>${esc(repo.name)}</strong></a>
    ${repo.private ? '<span class="pill pill-private">Private</span>' : ''}
  </div>
  <p class="muted">${esc(repo.description || 'No description')}</p>
  <p class="muted small">Created ${esc(formatWhen(Date.parse(repo.createdAt)))}</p>
</li>`
        )
        .join('')
    : '<li class="repo-card muted">No repositories yet.</li>';

  return layout({
    title: profile.login,
    user,
    flash,
    body: `<div class="profile-head">
  <div class="avatar">${esc(profile.login[0].toUpperCase())}</div>
  <div>
    <h1>${esc(profile.login)}</h1>
    <p class="muted">${profile.email ? esc(profile.email) + ' | ' : ''}Joined ${esc(formatWhen(Date.parse(profile.createdAt)))}</p>
  </div>
</div>
${isSelf ? gauge(accountBytes, MAX_ACCOUNT_BYTES, 'Storage across all repositories') : ''}
<div class="page-head">
  <h2>${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}</h2>
  ${isSelf ? '<a class="btn" href="/new">New repository</a>' : ''}
</div>
<ul class="repo-list">${cards}</ul>`,
  });
}

function notFoundPage({ user, what }) {
  return layout({
    title: 'Not found',
    user,
    body: `<div class="narrow">
  <h1>404</h1>
  <p>${esc(what || 'That page does not exist.')}</p>
  <p><a class="linkish" href="/">Back to repositories</a></p>
</div>`,
  });
}

module.exports = {
  esc,
  hrefPath,
  formatBytes,
  formatWhen,
  layout,
  repoHeader,
  repoSidebar,
  repoEmpty,
  branchPicker,
  commitRow,
  blobTable,
  dashboard,
  newRepoPage,
  importPage,
  authPage,
  profilePage,
  notFoundPage,
};
