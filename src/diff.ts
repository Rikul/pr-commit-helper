/**
 * Turns GitHub's per-file `patch` text into hunks with new-file line numbers,
 * so the model can cite exact lines and we can check which lines accept
 * inline review comments (RIGHT side: added or context lines inside a hunk).
 */

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  /** Line number in the new file (undefined for deleted lines). */
  newLine?: number;
  oldLine?: number;
  text: string;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  previousPath?: string;
  status: string;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/;

export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.split('\n')) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      current = { header: raw, lines: [] };
      hunks.push(current);
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      continue;
    }
    if (!current) continue;
    // Skips "\ No newline at end of file" and the empty string after a trailing newline.
    if (raw === '' || raw.startsWith('\\')) continue;

    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === '+') {
      current.lines.push({ kind: 'add', newLine: newNo++, text });
    } else if (marker === '-') {
      current.lines.push({ kind: 'del', oldLine: oldNo++, text });
    } else if (marker === ' ') {
      current.lines.push({ kind: 'ctx', oldLine: oldNo++, newLine: newNo++, text });
    }
  }
  return hunks;
}

/** New-file line numbers that GitHub accepts for RIGHT-side review comments. */
export function commentableLines(file: FileDiff): Set<number> {
  const set = new Set<number>();
  for (const h of file.hunks) {
    for (const l of h.lines) if (l.newLine !== undefined) set.add(l.newLine);
  }
  return set;
}

/** Index of the hunk containing a new-file line, or -1. */
export function hunkIndexOf(file: FileDiff, line: number): number {
  return file.hunks.findIndex((h) => h.lines.some((l) => l.newLine === line));
}

export function renderHunk(h: Hunk): string {
  const out = [h.header];
  for (const l of h.lines) {
    const no = l.newLine !== undefined ? String(l.newLine).padStart(5) : '     ';
    const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
    out.push(`${no} ${sign} ${l.text}`);
  }
  return out.join('\n');
}

export function renderFileHeader(f: FileDiff): string {
  const rename = f.previousPath && f.previousPath !== f.path ? ` (renamed from ${f.previousPath})` : '';
  return `### File: ${f.path} [${f.status}]${rename}`;
}

/**
 * Packs files (and, for oversized files, individual hunks) into chunks whose
 * rendered size stays under `maxChars`. A single hunk larger than the budget
 * still gets its own chunk rather than being cut.
 */
export function chunkDiff(files: FileDiff[], maxChars: number): string[] {
  const chunks: string[] = [];
  let buf: string[] = [];
  let size = 0;

  const flush = () => {
    if (buf.length) chunks.push(buf.join('\n\n'));
    buf = [];
    size = 0;
  };
  const push = (piece: string) => {
    if (size + piece.length > maxChars && buf.length) flush();
    buf.push(piece);
    size += piece.length + 2;
  };

  for (const f of files) {
    const header = renderFileHeader(f);
    const whole = [header, ...f.hunks.map(renderHunk)].join('\n');
    if (whole.length <= maxChars) {
      push(whole);
      continue;
    }
    for (const h of f.hunks) push(`${header} (partial)\n${renderHunk(h)}`);
  }
  flush();
  return chunks;
}
