// Line diff for the commit page. A plain LCS over the two line arrays: correct
// and readable, at the cost of O(n*m). Files past the cap are counted by
// length only so one huge file cannot stall a page render.

const MAX_DIFF_LINES = 1200;

function splitLines(body) {
  const text = body.toString('utf8');
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Returns rows of {kind, text}. kind is 'ctx', 'add' or 'del'.
function diffLines(before, after) {
  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) return null;
  const n = before.length;
  const m = after.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] =
        before[i] === after[j]
          ? table[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      rows.push({ kind: 'ctx', text: before[i] });
      i++;
      j++;
    } else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) {
      rows.push({ kind: 'del', text: before[i] });
      i++;
    } else {
      rows.push({ kind: 'add', text: after[j] });
      j++;
    }
  }
  while (i < n) rows.push({ kind: 'del', text: before[i++] });
  while (j < m) rows.push({ kind: 'add', text: after[j++] });
  return rows;
}

// Hides runs of unchanged lines so the page does not carry the whole file.
// A hidden run becomes one 'gap' row carrying the number of lines skipped.
function collapse(rows, context = 3) {
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === 'ctx') continue;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) {
      keep[k] = true;
    }
  }
  const kept = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (skipped) {
        kept.push({ kind: 'gap', count: skipped });
        skipped = 0;
      }
      kept.push(rows[i]);
    } else {
      skipped++;
    }
  }
  if (skipped) kept.push({ kind: 'gap', count: skipped });
  return kept;
}

function numberLines(rows) {
  let oldNo = 1;
  let newNo = 1;
  return rows.map((row) => {
    if (row.kind === 'gap') return row;
    const numbered = { kind: row.kind, text: row.text, oldNo: null, newNo: null };
    if (row.kind !== 'add') numbered.oldNo = oldNo++;
    if (row.kind !== 'del') numbered.newNo = newNo++;
    return numbered;
  });
}

module.exports = { splitLines, diffLines, collapse, numberLines, MAX_DIFF_LINES };
