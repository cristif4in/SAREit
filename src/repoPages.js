// Repository pages: code browser, blob view, commit list, commit detail,
// branch and tag lists, settings.

const {
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
} = require('./views');
const objects = require('./git/objects');
const repo = require('./git/repo');
const diff = require('./git/diff');
const readme = require('./readme');
const { MAX_REPO_BYTES, MAX_ACCOUNT_BYTES } = require('./config');

// A render walks every line and a repository can hold a file of any size, so
// the ceiling is what keeps a page render from becoming an afternoon.
const README_RENDER_BYTES = 512 * 1024;

const RAW_PREVIEW_BYTES = 512 * 1024;

function baseHref(record) {
  return `/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.name)}`;
}

function canManage(record, viewer) {
  return !!viewer && viewer.login.toLowerCase() === record.owner.toLowerCase();
}

function defaultBranchName(branches) {
  return branches.length ? branches[0].name : 'main';
}

function currentBranchName(branches, ref) {
  if (ref === 'HEAD') return defaultBranchName(branches);
  const hit = branches.find((branch) => branch.name === ref);
  return hit ? hit.name : ref;
}

// A branch name can contain a slash, so a ref and a path are told apart by
// longest match in the router and the crumb just renders what it was given.
function crumbs(base, ref, pathSegments, leafKind) {
  const parts = [`<a class="crumb" href="${base}/tree/${hrefPath([ref])}">${esc(ref)}</a>`];
  pathSegments.forEach((part, index) => {
    const walked = pathSegments.slice(0, index + 1);
    const kind = index === pathSegments.length - 1 ? leafKind : 'tree';
    parts.push(
      `<span class="crumb-sep">/</span><a class="crumb" href="${base}/${kind}/${hrefPath([ref, ...walked])}">${esc(part)}</a>`
    );
  });
  return parts.join('');
}

function withSidebar({ record, viewer, active, ref, branches, tags, sizeBytes, accountBytes, cloneUrl, main }) {
  return `${repoHeader({
    repo: record,
    viewer,
    active,
    ref,
    branchesCount: branches.length,
    tagsCount: tags.length,
  })}
<div class="repo-body">
  <section class="repo-main">${main}</section>
  ${repoSidebar({
    repo: record,
    sizeBytes,
    accountBytes,
    cloneUrl,
    defaultBranch: defaultBranchName(branches),
    isOwner: canManage(record, viewer),
    importedFrom: record.importedFrom,
  })}
</div>`;
}

// Relative to the README's own directory, pointed at the blob that serves it.
// An absolute URL is left for the browser to fetch wherever it lives.
function readmeResolver(base, ref, pathSegments) {
  return (target) => {
    const segments = target.split('/').filter(Boolean);
    const walked = [];
    for (const segment of segments) {
      if (segment === '.') continue;
      if (segment === '..') {
        walked.pop();
        continue;
      }
      walked.push(segment);
    }
    return `/${base}${hrefPath([ref, ...pathSegments, ...walked])}`;
  };
}

// A plain README.txt is text, and this is a markdown viewer, so it is linked
// rather than rendered.
function readmeBlock({ record, resolvedRef, pathSegments, readmeFile, readmeBody }) {
  const base = baseHref(record);
  const link = `${base}/blob/${hrefPath([resolvedRef, ...pathSegments, readmeFile])}`;

  if (!/\.mdx?$/i.test(readmeFile)) {
    return `<div class="readme"><a href="${link}">${esc(readmeFile)}</a></div>`;
  }

  const body = readmeBody;
  if (!body || body.length === 0) return '';
  if (body.length > README_RENDER_BYTES) {
    return `<div class="readme"><p class="muted small">README is ${esc(formatBytes(body.length))}, past the ${esc(
      formatBytes(README_RENDER_BYTES)
    )} render limit.</p><p><a href="${link}">Read ${esc(readmeFile)}</a></p></div>`;
  }
  if (objects.isBinary(body)) return '';

  const html = readme.render(body.toString('utf8'), { resolvePath: readmeResolver(base, resolvedRef, pathSegments) });
  return `<article class="readme readme-body">
  <div class="readme-head">${esc(readmeFile)}</div>
  ${html}
</article>`;
}

function codePage({ repo: record, viewer, ref, pathSegments, entries, lastCommits, readmeNames, readmeBody, branches, tags, sizeBytes, accountBytes, cloneUrl, user }) {
  const base = baseHref(record);
  const resolvedRef = ref || 'HEAD';
  const rows = entries.map((entry) => {
    const last = lastCommits.get(entry.name);
    return { ...entry, subject: last?.subject || '', sha: last?.sha || '' };
  });
  const parentSegments = pathSegments.slice(0, -1);
  const upLink = pathSegments.length
    ? `<a class="up" href="${base}/tree/${hrefPath([resolvedRef, ...parentSegments])}">..</a>`
    : '';

  const readmeFile = readmeName(readmeNames);
  const readmeLine = readmeFile
    ? readmeBlock({ record, resolvedRef, pathSegments, readmeFile, readmeBody })
    : '';

  const main = `${branchPicker({ branches, current: currentBranchName(branches, resolvedRef), base })}
<div class="pathbar"><div>${upLink} ${crumbs(base, resolvedRef, pathSegments, 'tree')}</div></div>
${
  entries.length
    ? blobTable({ entries: rows, base, ref: resolvedRef, pathSegments })
    : '<p class="muted pad">This directory is empty.</p>'
}
${readmeLine}`;

  return layout({
    title: `${record.owner}/${record.name}`,
    user,
    body: withSidebar({
      record,
      viewer,
      active: 'code',
      ref: resolvedRef,
      branches,
      tags,
      sizeBytes,
      accountBytes,
      cloneUrl,
      main,
    }),
  });
}

// The repository page while its copy is running. Drawn from the job as it
// stands so a reload is right, and public/app.js then follows the status.
function importPage({ record, job, statusUrl, context, viewer, user }) {
  const base = baseHref(record);
  const percent = Math.max(0, Math.min(100, job.percent));
  const moving = !job.reported;
  const source = record.importedFrom || 'a git remote';
  const elapsed = job.seconds < 60 ? `${job.seconds}s` : `${Math.floor(job.seconds / 60)}m ${job.seconds % 60}s`;

  const body = job.state === 'failed'
    ? `<div class="flash flash-error">Import failed: ${esc(job.error)}</div>
       <p class="muted small">The repository row is still here with nothing in it.</p>
       <p><a class="linkish" href="${base}/settings">Delete this repository</a></p>`
    : `<p class="import-line"><span data-import-phase>${esc(job.phase)}</span>${job.detail ? ` <span class="muted small">${esc(job.detail)}</span>` : ''}</p>
       <p class="muted small" data-import-elapsed>${esc(elapsed)} elapsed. Private until it finishes. Leave this page and come back whenever.</p>
       <noscript><p class="muted small">Reload to see how far the copy has got.</p></noscript>`;

  return layout({
    title: `Importing ${record.name}`,
    user,
    body: `${repoHeader({
    repo: record,
    viewer,
    active: 'code',
    ref: context.defaultBranch,
    branchesCount: context.branches.length,
    tagsCount: context.tags.length,
  })}
<div class="repo-body">
  <section class="repo-main">
    <section class="panel" data-import-status="${esc(statusUrl)}">
      <h2>Importing from ${esc(source)}</h2>
      <div class="import-bar" role="progressbar" aria-label="Import progress" aria-valuemin="0" aria-valuemax="100"${
        moving || job.state === 'failed' ? '' : ` aria-valuenow="${percent}"`
      }>
        <div class="import-fill" data-import-bar style="width:${moving ? 30 : percent}%"${moving ? ' data-moving' : ''}></div>
      </div>
      ${body}
    </section>
  </section>
  ${repoSidebar({
    repo: record,
    sizeBytes: context.sizeBytes,
    accountBytes: context.accountBytes,
    cloneUrl: context.cloneUrl,
    defaultBranch: context.defaultBranch,
    isOwner: canManage(record, viewer),
    importedFrom: record.importedFrom,
  })}
</div>`,
  });
}

function readmeName(names) {
  for (const candidate of ['README.md', 'readme.md', 'Readme.md', 'README', 'README.txt']) {
    if (names.has(candidate)) return candidate;
  }
  return null;
}

function emptyPage({ repo: record, viewer, branches, tags, sizeBytes, accountBytes, cloneUrl, user }) {
  const main = repoEmpty({ repo: record, cloneUrl });
  return layout({
    title: `${record.owner}/${record.name}`,
    user,
    body: withSidebar({ record, viewer, active: 'code', ref: 'main', branches, tags, sizeBytes, accountBytes, cloneUrl, main }),
  });
}

function blobPage({ repo: record, viewer, ref, pathSegments, blob, mode, branches, tags, sizeBytes, accountBytes, cloneUrl, user }) {
  const base = baseHref(record);
  const fileName = pathSegments[pathSegments.length - 1] || 'blob';
  const rawHref = `${base}/raw/${hrefPath([ref, ...pathSegments])}`;
  const tooBig = blob.length > RAW_PREVIEW_BYTES;
  const binary = objects.isBinary(blob);
  const lineCount = blob.toString('utf8').split('\n').length;

  // MIT detection. The filename is the first signal, but a LICENSE file that
  // says MIT inside it is what actually makes it one, so both are checked.
  const isLicenseName = /^(LICENSE|LICENCE|COPYING|UNLICENSE)(\.(md|txt))?$/i.test(fileName);
  const licenseText = !binary ? blob.toString('utf8') : '';
  const isMit = isLicenseName && /\bMIT\b/i.test(licenseText) && /permission is hereby granted/i.test(licenseText);

  const licenseBoard = isMit ? renderLicenseBoard() : '';

  const preview = binary
    ? `<p class="pad muted">Binary file, ${esc(formatBytes(blob.length))}.</p>`
    : tooBig
      ? `<p class="pad muted">File is ${esc(formatBytes(blob.length))}, past the ${esc(formatBytes(RAW_PREVIEW_BYTES))} preview limit. Use the Raw link.</p>`
      : `${licenseBoard}<table class="code-table"><tbody>${codeRows(blob)}</tbody></table>`;

  const main = `<div class="pathbar"><div>${crumbs(base, ref, pathSegments, 'blob')}</div></div>
<div class="blobbar">
  <span class="muted">${esc(fileName)}</span>
  <span>${esc(formatBytes(blob.length))}</span>
  ${binary ? '<span class="muted">binary</span>' : `<span>${lineCount} lines</span>`}
  <span class="muted">mode ${esc(mode)}</span>
  <a class="btn btn-ghost btn-sm" href="${rawHref}">Raw</a>
</div>
${preview}`;

  return layout({
    title: `${fileName} | ${record.owner}/${record.name}`,
    user,
    body: withSidebar({
      record,
      viewer,
      active: 'code',
      ref,
      branches,
      tags,
      sizeBytes,
      accountBytes,
      cloneUrl,
      main,
    }),
  });
}

// The MIT board that sits above a recognised license file.
//
// It is deliberately not a GitHub-style summary card: the icon is a custom
// scales SVG, the permissions and limits are plain rows rather than tables of
// check and cross marks, and the whole thing is bordered like the rest of
// SAREit's panels instead of being a rounded grey box.
function renderLicenseBoard() {
  const svg = `<svg class="license-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
  <path d="M12 2.6 3.4 6.2v5.1c0 5 3.6 8.6 8.6 10.1 5-1.5 8.6-5.1 8.6-10.1V6.2L12 2.6Z"
        fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M12 7.6v8.8M8.1 16.4h7.8" fill="none" stroke="currentColor"
        stroke-width="1.5" stroke-linecap="round"/>
  <path d="M8.1 9.2 6 13.4h4.2L8.1 9.2ZM15.9 9.2l-2.1 4.2H18l-2.1-4.2Z"
        fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
</svg>`;

  const permission = (label) => `<li class="license-perm">${esc(label)}</li>`;
  const limit = (label) => `<li class="license-limit">${esc(label)}</li>`;

  return `<section class="license-board" aria-label="MIT License summary">
  <div class="license-board-head">
    ${svg}
    <div class="license-board-title">
      <h2>MIT License</h2>
      <p>This repository is released under the MIT license. You can use, change and share it, including commercially, as long as the copyright notice and this permission notice travel with it.</p>
    </div>
    <span class="license-badge">MIT</span>
  </div>
  <div class="license-board-body">
    <div class="license-col">
      <h3>You can</h3>
      <ul>
        ${permission('Use it commercially')}
        ${permission('Change it')}
        ${permission('Share it')}
        ${permission('Use it privately')}
      </ul>
    </div>
    <div class="license-col">
      <h3>You cannot</h3>
      <ul>
        ${limit('Hold the author liable')}
        ${limit('Expect a warranty')}
      </ul>
    </div>
    <div class="license-col">
      <h3>You must</h3>
      <ul>
        ${permission('Keep the license and copyright notice')}
      </ul>
    </div>
  </div>
  <p class="license-board-foot">This is a plain-language summary, not legal advice. The text below is the license itself.</p>
</section>`;
}

function codeRows(blob) {
  return blob
    .toString('utf8')
    .split('\n')
    .map(
      (line, index) =>
        `<tr><td class="lineno"><a href="#L${index + 1}">${index + 1}</a></td><td><pre>${esc(line) || ' '}</pre></td></tr>`
    )
    .join('');
}

function commitsPage({ repo: record, viewer, ref, commits, truncated, nextCursor, branches, tags, sizeBytes, accountBytes, cloneUrl, user, isEmpty }) {
  const base = baseHref(record);
  // The next page is asked for as the reader reaches this one rather than the
  // whole history arriving with the first, which is what made this page cost the
  // same however deep the repository was.
  const more = nextCursor
    ? `<div class="pad"><a class="btn btn-ghost" href="${base}/commits/${hrefPath([ref])}?after=${encodeURIComponent(nextCursor)}">Older commits</a></div>`
    : truncated
      ? '<p class="pad muted">This history is deeper than the walk SAREit does for this page. Clone the repository to read the rest.</p>'
      : '';
  const main = `<div class="pathbar"><div><span class="crumb">Commits on ${esc(ref)}</span></div></div>
${
  isEmpty
    ? repoEmpty({ repo: record, cloneUrl })
    : `<ul class="commit-list">${commits
        .map((commit) => commitRow({ commit, base }))
        .join('')}</ul>${more}`
}`;

  return layout({
    title: `Commits | ${record.owner}/${record.name}`,
    user,
    body: withSidebar({ record, viewer, active: 'commits', ref, branches, tags, sizeBytes, accountBytes, cloneUrl, main }),
  });
}

function commitPage({ repo: record, viewer, ref, commit, parents, changed, branches, tags, sizeBytes, accountBytes, cloneUrl, user }) {
  const base = baseHref(record);
  const parentLinks = parents
    .map((sha) => `<a class="sha" href="${base}/commit/${esc(sha)}">${esc(sha.slice(0, 7))}</a>`)
    .join(' <span class="muted">&rarr;</span> ');
  const added = changed.reduce((sum, file) => sum + file.additions, 0);
  const removed = changed.reduce((sum, file) => sum + file.deletions, 0);

  const files = changed
    .map((file) => {
      const body = file.rows
        ? `<table class="diff-table"><tbody>${file.rows.map(diffRow).join('')}</tbody></table>`
        : `<p class="muted pad">${esc(file.skipped)}</p>`;
      return `<details class="diff-file"${file.rows ? ' open' : ''}>
  <summary>
    <span class="stat-add">+${file.additions}</span>
    <span class="stat-del">-${file.deletions}</span>
    <span class="stat-bar"><i class="bar-add" style="width:${file.barAdd}%"></i><i class="bar-del" style="width:${file.barDel}%"></i></span>
    <a href="${base}/blob/${hrefPath([commit.sha, ...file.segments])}">${esc(file.path)}</a>
    ${file.status === 'modified' ? '' : `<span class="pill">${esc(file.status)}</span>`}
  </summary>
  ${body}
</details>`;
    })
    .join('');

  const main = `<div class="commit-banner">
  <div class="avatar sm">${esc((commit.author.name || '?')[0].toUpperCase())}</div>
  <div>
    <div>${esc(commit.author.name || 'unknown')} committed ${esc(formatWhen(commit.committer.when))}</div>
    ${
      commit.pushedBy
        ? `<div class="muted small">pushed to this server by ${esc(commit.pushedBy)}</div>`
        : ''
    }
    <div class="commit-subject">${esc(commit.subject || 'No commit message')}</div>
  </div>
</div>
<div class="meta-strip">
  <span>commit <a class="sha" href="${base}/commit/${esc(commit.sha)}">${esc(commit.sha)}</a></span>
  <span>parent ${parentLinks || '<span class="muted">none</span>'}</span>
  <span class="stat-add">+${added}</span>
  <span class="stat-del">-${removed}</span>
  <span>${changed.length} file${changed.length === 1 ? '' : 's'} changed</span>
</div>
${commit.message.split('\n').slice(1).filter((line) => line.trim()).map((line) => `<p class="commit-message">${esc(line)}</p>`).join('')}
${files || '<p class="muted pad">No file changes.</p>'}`;

  return layout({
    title: `${commit.subject || commit.sha} | ${record.owner}/${record.name}`,
    user,
    body: withSidebar({ record, viewer, active: 'commits', ref, branches, tags, sizeBytes, accountBytes, cloneUrl, main }),
  });
}

function diffRow(row) {
  if (row.kind === 'gap') {
    return `<tr class="gap"><td colspan="3">${row.count} unchanged line${row.count === 1 ? '' : 's'}</td></tr>`;
  }
  const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
  return `<tr class="d-${row.kind}"><td class="lineno">${row.oldNo || ''}</td><td class="lineno">${row.newNo || ''}</td><td><pre><span class="marker">${marker}</span>${esc(row.text) || ' '}</pre></td></tr>`;
}

function flattenTree(dir, treeSha, prefix = '') {
  const map = new Map();
  const obj = treeSha ? repo.readObject(dir, treeSha) : null;
  if (!obj || obj.type !== 'tree') return map;
  for (const entry of objects.parseTree(obj.body)) {
    const full = `${prefix}${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      for (const [key, value] of flattenTree(dir, entry.sha, `${full}/`)) map.set(key, value);
    } else {
      map.set(full, { sha: entry.sha, mode: entry.mode });
    }
  }
  return map;
}

function blobBody(dir, sha) {
  if (!sha) return Buffer.alloc(0);
  const obj = repo.readObject(dir, sha);
  return obj ? obj.body : Buffer.alloc(0);
}

// Flattens both trees to path keyed maps, then diffs only the blobs that moved.
// Submodule entries carry a commit id rather than a blob, so they are counted
// without a diff.
function changedFiles(dir, fromTree, toTree) {
  const before = flattenTree(dir, fromTree);
  const after = flattenTree(dir, toTree);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const out = [];

  for (const filePath of [...paths].sort()) {
    const a = before.get(filePath);
    const b = after.get(filePath);
    if (a && b && a.sha === b.sha) continue;

    const status = !a ? 'added' : !b ? 'removed' : 'modified';
    const oldBody = a && a.mode !== '160000' ? blobBody(dir, a.sha) : Buffer.alloc(0);
    const newBody = b && b.mode !== '160000' ? blobBody(dir, b.sha) : Buffer.alloc(0);

    if (objects.isBinary(oldBody) || objects.isBinary(newBody)) {
      out.push({
        path: filePath,
        segments: filePath.split('/'),
        status,
        additions: 0,
        deletions: 0,
        rows: null,
        skipped: 'Binary file not shown.',
      });
      continue;
    }

    const rows = diff.diffLines(diff.splitLines(oldBody), diff.splitLines(newBody));
    const additions = rows ? rows.filter((row) => row.kind === 'add').length : 0;
    const deletions = rows ? rows.filter((row) => row.kind === 'del').length : 0;
    const total = additions + deletions || 1;
    out.push({
      path: filePath,
      segments: filePath.split('/'),
      status,
      additions,
      deletions,
      rows: rows ? diff.numberLines(diff.collapse(rows)) : null,
      barAdd: Math.round((additions / total) * 100),
      barDel: Math.round((deletions / total) * 100),
      skipped: rows ? null : `Diff skipped, over ${diff.MAX_DIFF_LINES} lines.`,
    });
  }
  return out;
}

function branchesPage({ repo: record, viewer, branches, tags, commits, sizeBytes, accountBytes, cloneUrl, user }) {
  const base = baseHref(record);
  const rows = branches.length
    ? branches
        .map((branch) => {
          const subject = commits.find((commit) => commit.sha === branch.sha)?.subject || '';
          return `<tr>
  <td class="name"><a href="${base}/tree/${hrefPath([branch.name])}">${esc(branch.name)}</a></td>
  <td class="msg"><a class="sha" href="${base}/commit/${esc(branch.sha)}">${esc(branch.sha.slice(0, 7))}</a> <span class="muted">${esc(subject)}</span></td>
</tr>`;
        })
        .join('')
    : '<tr><td colspan="2" class="muted pad">No branches yet.</td></tr>';

  const main = `<table class="blob-table">
  <thead><tr><th>Branch</th><th>Latest commit</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;

  return layout({
    title: `Branches | ${record.owner}/${record.name}`,
    user,
    body: withSidebar({ record, viewer, active: 'branches', ref: defaultBranchName(branches), branches, tags, sizeBytes, accountBytes, cloneUrl, main }),
  });
}

function tagsPage({ repo: record, viewer, branches, tags, sizeBytes, accountBytes, cloneUrl, user }) {
  const base = baseHref(record);
  const rows = tags.length
    ? tags
        .map(
          (tag) => `<tr>
  <td class="name"><a href="${base}/tree/${hrefPath([tag.name])}">${esc(tag.name)}</a></td>
  <td class="msg"><a class="sha" href="${base}/commit/${esc(tag.target || '')}">${esc((tag.target || '').slice(0, 7))}</a></td>
</tr>`
        )
        .join('')
    : '<tr><td colspan="2" class="muted pad">No tags yet.</td></tr>';

  const main = `<table class="blob-table">
  <thead><tr><th>Tag</th><th>Commit</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;

  return layout({
    title: `Tags | ${record.owner}/${record.name}`,
    user,
    body: withSidebar({ record, viewer, active: 'tags', ref: defaultBranchName(branches), branches, tags, sizeBytes, accountBytes, cloneUrl, main }),
  });
}

// Tokens live on the account, not the repository, so this block is the same
// wherever it is rendered from. The value is shown exactly once, at creation:
// only a hash is stored, so there is nothing to show again.
function tokenPanel({ base, tokens, fresh, csrf }) {
  const token = csrf ? `<input type="hidden" name="csrf" value="${esc(csrf)}">` : '';

  const freshBlock = fresh
    ? `<div class="flash flash-ok">Copy this now. It is not shown again.</div>
       <div class="token-value" data-select-on-click>${esc(fresh)}</div>
       <p class="muted small">Use it as the password in place of your account password:</p>
       <pre><code>git remote add sareit http://HOST:11707/OWNER/REPO.git
git push sareit main
# password: the token above, username: your SAREit login</code></pre>`
    : '';

  const rows = tokens.length
    ? tokens
        .map(
          (row) => `<li class="${row.revoked_at ? 'token-revoked' : ''}">
  <div>
    <div>${esc(row.name || 'Unnamed token')}</div>
    <div class="muted small">
      ${esc(row.id)}
      | created ${esc(formatWhen(Date.parse(row.created_at)))}
      ${row.last_used_at ? `| last used ${esc(formatWhen(Date.parse(row.last_used_at)))}` : '| never used'}
      ${row.revoked_at ? '| revoked' : ''}
    </div>
  </div>
  ${
    row.revoked_at
      ? ''
      : `<form method="post" action="${base}/settings/tokens/revoke" data-confirm="Revoke this token? Anything using it stops working at once.">
    ${token}
    <input type="hidden" name="token" value="${esc(row.id)}">
    <button class="btn btn-ghost btn-sm" type="submit">Revoke</button>
  </form>`
  }
</li>`
        )
        .join('')
    : '<li class="muted">No tokens yet.</li>';

  return `<section class="panel">
  <h2>Access tokens</h2>
  <p class="muted">A token stands in for your password when talking to git, so a machine you push from never holds the password that signs you in to the site. Over plain HTTP that is the difference between a leaked credential that unlocks your account and one that only pushes.</p>
  ${freshBlock}
  <ul class="token-list">${rows}</ul>
  <form method="post" action="${base}/settings/tokens" class="stack" style="margin-top:16px">
    ${token}
    <label>Token name
      <input type="text" name="name" value="" maxlength="60" placeholder="laptop, build server">
    </label>
    <div class="actions"><button class="btn" type="submit">Create token</button></div>
  </form>
</section>`;
}

function settingsPage({ repo: record, user, branches, sizeBytes, accountBytes, flash, csrf, tokens, freshToken }) {
  const base = baseHref(record);
  const token = csrf ? `<input type="hidden" name="csrf" value="${esc(csrf)}">` : '';
  const visibilityNote = record.private
    ? '<p class="muted">A private repository is hidden from the dashboard and needs your credentials over HTTP to clone or push.</p>'
    : '';

  const body = `<div class="narrow">
  <h1>${esc(record.owner)}/${esc(record.name)} settings</h1>
  ${flash ? `<div class="flash flash-${flash.kind}">${esc(flash.text)}</div>` : ''}
  <section class="panel">
    <h2>General</h2>
    <form method="post" action="${base}/settings" class="stack">
      ${token}
      <label>Description
        <input type="text" name="description" value="${esc(record.description)}" maxlength="180">
      </label>
      <label class="check"><input type="checkbox" name="private" value="1"${record.private ? ' checked' : ''}> Private repository</label>
      ${visibilityNote}
      <div class="actions"><button class="btn" type="submit">Save</button></div>
    </form>
  </section>
  ${tokenPanel({ base, tokens, fresh: freshToken, csrf })}
  <section class="panel">
    <h2>Danger zone</h2>
    <p class="muted">Delete removes the metadata and every object under it. Clone first if the history matters.</p>
    <form method="post" action="${base}/settings/delete" data-confirm="Delete ${esc(record.owner)}/${esc(record.name)} and everything in it?">
      ${token}
      <button class="btn btn-danger" type="submit">Delete this repository</button>
    </form>
  </section>
  <p class="muted small">This repository uses ${esc(formatBytes(sizeBytes))} of ${esc(formatBytes(MAX_REPO_BYTES))}. The account total across every repository is ${esc(formatBytes(accountBytes))} of ${esc(formatBytes(MAX_ACCOUNT_BYTES))}.</p>
  <p><a class="linkish" href="${base}">Back to ${esc(record.name)}</a></p>
</div>`;

  return layout({ title: `Settings | ${record.owner}/${record.name}`, user, body });
}

module.exports = {
  codePage,
  importPage,
  emptyPage,
  blobPage,
  commitsPage,
  commitPage,
  branchesPage,
  tagsPage,
  settingsPage,
  changedFiles,
  readmeName,
  README_RENDER_BYTES,
};