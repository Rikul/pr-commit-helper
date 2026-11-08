import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SEVERITIES, type Severity, severityRank } from './config';
import { commentableLines, hunkIndexOf, lineContext, lineText, type FileDiff } from './diff';

const FindingSchema = z.object({
  path: z.string().min(1),
  line: z.coerce.number().int().positive(),
  start_line: z.coerce.number().int().positive().nullish(),
  severity: z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(SEVERITIES))
    .catch('medium'),
  category: z.string().catch('other'),
  title: z.string().min(1),
  body: z.string().default(''),
  suggestion: z.string().nullish(),
});

const ReviewSchema = z.object({
  summary: z.string().default(''),
  findings: z.array(z.unknown()).default([]),
});

export type Finding = z.infer<typeof FindingSchema>;

export interface ParsedReview {
  summary: string;
  findings: Finding[];
  /** Number of finding objects that failed validation and were dropped. */
  invalid: number;
}

/**
 * Reads the JSON object from model output. Plain JSON is tried first, so code
 * fences inside finding bodies are left alone; then a response wrapped in one
 * outer fence; then the outermost {...} in surrounding prose.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!);
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object found in model output.');
  return JSON.parse(trimmed.slice(start, end + 1));
}

export function parseReview(text: string): ParsedReview {
  const raw = ReviewSchema.parse(extractJson(text));
  const findings: Finding[] = [];
  let invalid = 0;
  for (const f of raw.findings) {
    const r = FindingSchema.safeParse(f);
    if (r.success) findings.push(r.data);
    else invalid++;
  }
  return { summary: raw.summary, findings, invalid };
}

export interface PlacedFinding extends Omit<Finding, 'start_line'> {
  start_line?: number;
  /** True when the finding maps to a commentable diff line and can be posted inline. */
  inline: boolean;
  /** Cited line + neighbours (+ occurrence number for repeated windows). Primary match for re-runs. */
  fingerprint: string;
  /** Cited line text only. Used as a fallback match when a neighbouring line was edited. */
  lineKey: string;
  /** True when the cited line's text appears once in the file's diff, so lineKey is unambiguous. */
  lineUnique: boolean;
}

const SNAP_DISTANCE = 3;

/**
 * Checks each finding against the diff. Findings on a line the diff does not
 * contain are moved to the nearest commentable line in the same file (within
 * a few lines) or marked non-inline so they go in the review body instead.
 */
export function placeFindings(findings: Finding[], files: FileDiff[]): PlacedFinding[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const indexes = new Map<FileDiff, FileIndex>();
  const indexOf = (file: FileDiff) => {
    let idx = indexes.get(file);
    if (!idx) indexes.set(file, (idx = indexFile(file)));
    return idx;
  };
  return findings.map((f) => {
    const file = byPath.get(f.path) ?? byPath.get(f.path.replace(/^\.?\//, ''));
    const path = file?.path ?? f.path;
    const offKey = hash(path, ['off', f.line]);
    const offDiff = { ...f, path, start_line: undefined, inline: false, fingerprint: offKey, lineKey: offKey, lineUnique: false };
    if (!file) return offDiff;

    const lines = commentableLines(file);
    let line = f.line;
    if (!lines.has(line)) {
      const nearest = [...lines]
        .filter((l) => Math.abs(l - line) <= SNAP_DISTANCE)
        .sort((a, b) => Math.abs(a - line) - Math.abs(b - line))[0];
      if (nearest === undefined) return offDiff;
      line = nearest;
    }

    let start_line = f.start_line ?? undefined;
    if (
      start_line !== undefined &&
      (start_line >= line || !lines.has(start_line) || hunkIndexOf(file, start_line) !== hunkIndexOf(file, line))
    ) {
      start_line = undefined;
    }
    // A suggestion only replaces the exact cited range; if we moved the line, drop it.
    const suggestion = line === f.line && start_line === (f.start_line ?? undefined) ? f.suggestion : undefined;

    // Keyed on where the finding is (file + cited code), never on its wording:
    // models reword titles between runs, and code text survives line shifts.
    const keys = indexOf(file).keys.get(line)!;
    return { ...f, path, line, start_line, suggestion, inline: true, ...keys };
  });
}

interface FileIndex {
  keys: Map<number, { fingerprint: string; lineKey: string; lineUnique: boolean }>;
}

/** Precomputes match keys for every commentable line of a file. */
function indexFile(file: FileDiff): FileIndex {
  const lines = [...commentableLines(file)].sort((a, b) => a - b);
  const textCount = new Map<string, number>();
  const windowSeen = new Map<string, number>();
  for (const l of lines) {
    const t = norm(lineText(file, l)!);
    textCount.set(t, (textCount.get(t) ?? 0) + 1);
  }
  const keys: FileIndex['keys'] = new Map();
  for (const l of lines) {
    const context = lineContext(file, l)!.map((p) => (p === null ? null : norm(p)));
    const windowId = JSON.stringify(context);
    // Identical windows (same line and same neighbours) are numbered in file order.
    const occurrence = windowSeen.get(windowId) ?? 0;
    windowSeen.set(windowId, occurrence + 1);
    const text = context[1]!;
    keys.set(l, {
      fingerprint: hash(file.path, ['ctx', context, occurrence]),
      lineKey: hash(file.path, ['line', text]),
      lineUnique: textCount.get(text) === 1,
    });
  }
  return { keys };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Hashes a path plus structured parts. JSON keeps line boundaries and null vs '' distinct. */
function hash(path: string, parts: unknown): string {
  return createHash('sha256').update(`${path}\n${JSON.stringify(parts)}`).digest('hex').slice(0, 16);
}

/** True when this finding (or an equivalent) was already posted on an earlier run. */
export function alreadyPosted(f: PlacedFinding, prior: { fingerprints: Set<string>; lineKeys: Set<string> }): boolean {
  return prior.fingerprints.has(f.fingerprint) || (f.lineUnique && prior.lineKeys.has(f.lineKey));
}

export function filterBySeverity<T extends { severity: Severity }>(findings: T[], min: Severity): T[] {
  return findings.filter((f) => severityRank(f.severity) >= severityRank(min));
}

/**
 * Removes duplicates within one run (same spot and same title), keeping the most
 * severe. Different titles on the same line stay separate within a run.
 */
export function dedupe<T extends PlacedFinding>(findings: T[]): T[] {
  const best = new Map<string, T>();
  for (const f of findings) {
    const key = `${f.fingerprint}\n${norm(f.title)}`;
    const prev = best.get(key);
    if (!prev || severityRank(f.severity) > severityRank(prev.severity)) best.set(key, f);
  }
  return [...best.values()].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.path.localeCompare(b.path) || a.line - b.line,
  );
}
