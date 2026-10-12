// README rendering

const CODE_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  jsx: 'javascript', json: 'json', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', yml: 'yaml',
  yaml: 'yaml', toml: 'toml', sql: 'sql', html: 'xml', xml: 'xml', css: 'css',
  scss: 'css', md: 'markdown', diff: 'diff', ini: 'ini', lua: 'lua', swift: 'swift',
  kt: 'kotlin', gradle: 'groovy', dockerfile: 'dockerfile',
};

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

// A path from a README into the repository is a link to a blob on this server
function resolveHref(url, resolve) {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('#')) return { href: trimmed, external: false };
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
    if (/^https?:/i.test(trimmed)) return { href: trimmed, external: true };
    return { href: '', external: false };
  }
  if (trimmed.startsWith('/')) return { href: '', external: false };
  return { href: resolve(collapse(trimmed)), external: false };
}

// "." and ".." are collapsed here rather than left for the browser, because the
// result becomes part of a path this server turns into a blob lookup, and a
// leading "../.." in there is exactly what must not survive. A percent sign
// that is not valid encoding makes the whole path unusable, so it yields
// nothing instead of throwing inside a page render.
function collapse(target) {
  let text;
  try {
    text = decodeURI(target);
  } catch {
    return '';
  }
  const out = [];
  for (const part of text.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

// An external link leaves this server, so it gets the attributes that keep the
// opener and the referrer out of it.
function linkAttrs(href, external) {
  return external ? ` href="${esc(href)}" target="_blank" rel="noopener noreferrer"` : ` href="${esc(href)}"`;
}

// Raw HTML is normally escaped, which is right for a <div> someone wrote as
// prose but wrong for a README pasted off github.com, where an image pasted as
// <img src=...> is how images actually arrive. So a small set of tags is parsed
// and re-emitted from the attributes read here rather than passed through:
// every other tag, every attribute outside the list, and every url that is not
// http(s) or a repository path is dropped.
const ALLOWED_TAGS = new Set(['img', 'a', 'b', 'i', 'em', 'strong', 'br', 'p', 'div', 'span', 'details', 'summary']);
const ALLOWED_ATTRS = {
  img: ['src', 'alt', 'width', 'height', 'title', 'align'],
  a: ['href', 'title'],
  '*': ['title', 'align'],
};

const VOID_TAGS = new Set(['img', 'br']);

function filterUrl(url, resolve) {
  const trimmed = url.trim();
  if (/^https?:/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return '';
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) return trimmed;
  return resolve ? resolve(collapse(trimmed)) : '';
}

// Rebuilds one allowed tag from its source text. Anything unrecognised in the
// attribute soup, including on*, style, srcset and formaction, is simply not
// copied, so it cannot reach the page.
function sanitizeTag(source, resolve) {
  const name = source.match(/^<\s*([a-z][a-z0-9]*)/i);
  if (!name || !ALLOWED_TAGS.has(name[1].toLowerCase())) return null;
  const tag = name[1].toLowerCase();

  const out = [];
  const pattern = /([a-z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let hit;
  while ((hit = pattern.exec(source)) !== null) {
    const key = hit[1].toLowerCase();
    const value = hit[3] !== undefined ? hit[3] : hit[4] !== undefined ? hit[4] : hit[5];
    if (key.startsWith('on')) continue;
    const allowed = ALLOWED_ATTRS[tag] || ALLOWED_ATTRS['*'];
    if (!allowed.includes(key)) continue;
    if (key === 'src' || key === 'href') {
      const resolved = filterUrl(value, resolve);
      if (!resolved) continue;
      out.push(`${key}="${esc(resolved)}"`);
      continue;
    }
    out.push(`${key}="${esc(value)}"`);
  }

  const closing = VOID_TAGS.has(tag) ? '' : `</${tag}>`;
  return `<${tag}${out.length ? ' ' + out.join(' ') : ''}>${closing}`;
}

// One tag of raw HTML, re-emitted from the attributes read here. A tag that is
// not on the list comes back as escaped text, so a <script> in a README stays
// visible as the text it was rather than disappearing.
function allowHtml(source, resolve) {
  const name = source.match(/^<\s*\/?\s*([a-z][a-z0-9]*)/i);
  if (!name || !ALLOWED_TAGS.has(name[1].toLowerCase())) return esc(source);
  if (source.startsWith('</')) return `</${name[1].toLowerCase()}>`;
  return sanitizeTag(source, resolve) || esc(source);
}

// Inline spans. The output is built from escaped pieces, so the only markup is
// what these produce. Emphasis and links are handled in one pass because a
// marker inside a link label has to stay inside it.
function inline(text, resolve) {
  const out = [];
  let buffer = '';
  let index = 0;

  const flush = () => {
    if (!buffer) return;
    out.push(esc(buffer));
    buffer = '';
  };

  while (index < text.length) {
    const rest = text.slice(index);

    const fence = rest.match(/^(`+)([\s\S]*?)\1/);
    if (fence) {
      flush();
      const code = fence[2].replace(/^ | $/, '');
      out.push(`<code>${esc(code)}</code>`);
      index += fence[0].length;
      continue;
    }

    const image = rest.match(/^!\[([^\]]*)\]\(\s*([^\s)]*)(?:\s+"([^"]*)")?\s*\)/);
    if (image) {
      flush();
      const target = resolveHref(image[2], resolve);
      if (target.href) {
        const title = image[3] ? ` title="${esc(image[3])}"` : '';
        // loading=lazy keeps a README with fifty screenshots from fetching all
        // of them before the reader has scrolled to any.
        out.push(`<img src="${esc(target.href)}" alt="${esc(image[1])}"${title} loading="lazy">`);
      } else {
        out.push(esc(image[0]));
      }
      index += image[0].length;
      continue;
    }

    // The URL runs to whitespace or a closing paren rather than to the first
    // paren, because a javascript: target may itself contain one and stopping
    // early would leave the tail of it as loose text on the page.
    const anchor = rest.match(/^\[([^\]]*)\]\(\s*([^\s)]*)(?:\s+"([^"]*)")?\s*\)/);
    if (anchor) {
      flush();
      const target = resolveHref(anchor[2], resolve);
      if (target.href) {
        const label = inline(anchor[1], resolve);
        const title = anchor[3] ? ` title="${esc(anchor[3])}"` : '';
        out.push(`<a${linkAttrs(target.href, target.external)}${title}>${label}</a>`);
      } else {
        // A dropped target keeps the whole source visible rather than leaving a
        // link-looking label that goes nowhere.
        out.push(esc(anchor[0]));
      }
      index += anchor[0].length;
      continue;
    }

    const bare = rest.match(/^<(https?:\/\/[^>\s]+)>/);
    if (bare) {
      flush();
      out.push(`<a${linkAttrs(bare[1], true)}>${esc(bare[1])}</a>`);
      index += bare[0].length;
      continue;
    }

    const strike = rest.match(/^~~([\s\S]+?)~~/);
    if (strike) {
      flush();
      out.push(`<del>${inline(strike[1], resolve)}</del>`);
      index += strike[0].length;
      continue;
    }

    const strong = rest.match(/^\*\*([\s\S]+?)\*\*/);
    if (strong) {
      flush();
      out.push(`<strong>${inline(strong[1], resolve)}</strong>`);
      index += strong[0].length;
      continue;
    }

    const emphasis = rest.match(/^(\*|_)([^\s*_][\s\S]*?)\1/);
    if (emphasis) {
      flush();
      out.push(`<em>${inline(emphasis[2], resolve)}</em>`);
      index += emphasis[0].length;
      continue;
    }

    const escaped = rest.match(/^\\([\\`*_{}\[\]()#+\-.!~|>])/);
    if (escaped) {
      buffer += escaped[1];
      index += escaped[0].length;
      continue;
    }

    const rawTag = /^<\/?\s*[a-z][a-z0-9]*((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(rest);
    if (rawTag) {
      flush();
      out.push(rawTag[0].startsWith('</') ? rawTag[0] : allowHtml(rawTag[0], resolve));
      index += rawTag[0].length;
      continue;
    }

    if (rest[0] === '<') {
      buffer += text[index];
      index += 1;
      continue;
    }

    buffer += text[index];
    index += 1;
  }

  flush();
  return out.join('');
}

function blockQuote(text, resolve) {
  return `<blockquote>${blocks(text, resolve)}</blockquote>`;
}

function heading(level, text, resolve) {
  return `<h${level}>${inline(text.trim(), resolve)}</h${level}>`;
}

function fence(body, language) {
  const key = String(language || '').toLowerCase();
  const name = CODE_EXT[key] || (/^[\w+#-]+$/.test(key) ? key : '');
  const label = name ? ` data-lang="${esc(name)}"` : '';
  return `<pre${label}><code>${esc(body.replace(/\n$/, ''))}</code></pre>`;
}

function tableRow(line, resolve) {
  const cells = splitRow(line);
  return `<tr>${cells.map((cell) => `<td>${inline(cell, resolve)}</td>`).join('')}</tr>`;
}

function splitRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
      continue;
    }
    if (text[i] === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += text[i];
  }
  cells.push(cell.trim());
  return cells;
}

// The header underline is |---|:--:|---: and its colons carry the alignment.
function tableAlign(line) {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return ' style="text-align:center"';
    if (right) return ' style="text-align:right"';
    if (left) return ' style="text-align:left"';
    return '';
  });
}

function list(lines, resolve, startIndex) {
  const first = LIST.exec(lines[startIndex]);
  const ordered = /\d/.test(first[1]);
  const items = [];

  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    const bullet = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(line) : /^\s*[-*+]\s+(.*)$/.exec(line);
    if (!bullet) {
      // A bullet of the other kind starts a list of its own, and anything else
      // ends this one. Without the break here a task list swallows every
      // following bullet as a continuation of its last item.
      if (LIST.test(line)) break;
      if (!/^\s{2,}\S/.test(line)) break;
    }

    const item = { lines: [] };
    const task = /^\[([ xX])\]\s+(.*)$/.exec(bullet[1]);
    if (task) {
      item.task = task[1].toLowerCase() === 'x';
      item.lines.push(task[2]);
    } else {
      item.lines.push(bullet[1]);
    }
    items.push(item);
    index++;

    // A continuation is an indented line that is not itself a bullet.
    while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !LIST.test(lines[index])) {
      item.lines.push(lines[index].trim());
      index++;
    }
  }

  const tag = ordered ? 'ol' : 'ul';
  const body = items
    .map((item) => {
      const text = item.lines.map((part) => inline(part, resolve)).join('<br>');
      const box = item.task === undefined
        ? ''
        : `<input type="checkbox" disabled${item.task ? ' checked' : ''}> `;
      return `<li>${box}${text}</li>`;
    })
    .join('');
  return [`<${tag} class="readme-list">${body}</${tag}>`, index];
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const LIST = /^\s*([-*+]|\d+[.)])\s+/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const INDENTED_CODE = /^ {4}(.*)$/;

function isTableDivider(line) {
  if (!line.includes('-')) return false;
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line);
}

function blocks(text, resolve) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index++;
      continue;
    }

    const fenceStart = FENCE.exec(line);
    if (fenceStart) {
      const marker = fenceStart[1][0];
      const language = fenceStart[2];
      const body = [];
      index++;
      while (index < lines.length) {
        const closer = FENCE.exec(lines[index]);
        if (closer && closer[1][0] === marker) {
          index++;
          break;
        }
        body.push(lines[index]);
        index++;
      }
      out.push(fence(body.join('\n'), language));
      continue;
    }

    const rule = RULE.exec(line);
    if (rule && !(LIST.test(line) && line.trim().length > 3)) {
      out.push('<hr>');
      index++;
      continue;
    }

    const headingMatch = HEADING.exec(line);
    if (headingMatch) {
      out.push(heading(headingMatch[1].length, headingMatch[2], resolve));
      index++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (index < lines.length && (QUOTE.test(lines[index]) || (lines[index].trim() && body.length && !isBlockStart(lines[index])))) {
        const quoted = QUOTE.exec(lines[index]);
        body.push(quoted ? quoted[1] : lines[index].trim());
        index++;
      }
      out.push(blockQuote(body.join('\n'), resolve));
      continue;
    }

    if (INDENTED_CODE.test(line) && !isTableDivider(line)) {
      const body = [];
      while (index < lines.length && (INDENTED_CODE.test(lines[index]) || !lines[index].trim())) {
        body.push(INDENTED_CODE.exec(lines[index])[1]);
        index++;
      }
      while (body.length && !body[body.length - 1].trim()) body.pop();
      out.push(fence(body.join('\n'), ''));
      continue;
    }

    // A table needs a header row and a divider under it; without the divider
    // these are two paragraphs that happen to contain pipes.
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const alignments = tableAlign(lines[index + 1]);
      const header = splitRow(line).map((cell, column) => `<th${alignments[column] || ''}>${inline(cell, resolve)}</th>`).join('');
      const body = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        body.push(tableRow(lines[index], resolve));
        index++;
      }
      out.push(`<table class="readme-table"><thead><tr>${header}</tr></thead><tbody>${body.join('')}</tbody></table>`);
      continue;
    }

    if (LIST.test(line)) {
      const [html, next] = list(lines, resolve, index);
      out.push(html);
      index = next;
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index].trim());
      index++;
    }
    if (paragraph.length) out.push(`<p>${inline(paragraph.join('\n'), resolve)}</p>`);
    else index++;
  }

  return out.join('\n');
}

function isBlockStart(line) {
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    LIST.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line) ||
    (line.includes('|') && /^\s*\|?\s*:?-{1,}/.test(line))
  );
}

// Headers are turned into ids so a README that links to its own section works.
// The slug is the plain text of the header, lowercased with the punctuation
// dropped, which is what the anchors in most READMEs already look like.
function slug(text) {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// The document is rendered twice: once to collect the header ids, then again
// with those ids available so a link to a section can be rewritten onto them.
// Doing it in one pass would mean the ids were not all known when the first
// link was met.
function render(markdown, { resolvePath } = {}) {
  const resolve = resolvePath || (() => '');
  let body = blocks(markdown, resolve);

  const seen = new Map();
  const header = /<h([1-6])>([\s\S]*?)<\/h\1>/g;
  const replacements = [];
  for (const match of body.matchAll(header)) {
    let id = slug(match[2].replace(/<[^>]*>/g, ''));
    if (!id) continue;
    const count = seen.get(id) || 0;
    seen.set(id, count + 1);
    if (count) id = `${id}-${count}`;
    replacements.push([match[0], match[0].replace('>', ` id="${esc(id)}">`)]);
  }
  for (const [from, to] of replacements) body = body.replace(from, to);

  body = body.replace(/href="#([^"]+)"/g, (whole, target) => {
    const wanted = String(target).toLowerCase();
    for (const [id] of seen) {
      if (id === wanted) return `href="#${esc(id)}"`;
    }
    return whole;
  });

  return body;
}

module.exports = { render, esc, resolveHref, inline, slug };