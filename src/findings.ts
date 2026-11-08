import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SEVERITIES, type Severity, severityRank } from './config';
import { commentableLines, hunkIndexOf, lineContext, type FileDiff } from './diff';

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
  fingerprint: string;
}

const SNAP_DISTANCE = 3;

/**
 * Checks each finding against the diff. Findings on a line the diff does not
 * contain are moved to the nearest commentable line in the same file (within
 * a few lines) or marked non-inline so they go in the review body instead.
 */
export function placeFindings(findings: Finding[], files: FileDiff[]): PlacedFinding[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return findings.map((f) => {
    const file = byPath.get(f.path) ?? byPath.get(f.path.replace(/^\.?\//, ''));
    const path = file?.path ?? f.path;
    const offDiff = { ...f, path, start_line: undefined, inline: false };
    if (!file) return { ...offDiff, fingerprint: fingerprint(path, `L${f.line}`) };

    const lines = commentableLines(file);
    let line = f.line;
    if (!lines.has(line)) {
      const nearest = [...lines]
        .filter((l) => Math.abs(l - line) <= SNAP_DISTANCE)
        .sort((a, b) => Math.abs(a - line) - Math.abs(b - line))[0];
      if (nearest === undefined) return { ...offDiff, fingerprint: fingerprint(path, `L${f.line}`) };
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

    // Keyed on where the finding is (file + cited code and its neighbours), not on its wording:
    // models reword titles between runs, and code text survives line shifts.
    // Re-runs use this to skip findings already posted at the same spot.
    const anchor = lineContext(file, line) ?? `L${line}`;
    return { ...f, path, line, start_line, suggestion, inline: true, fingerprint: fingerprint(path, anchor) };
  });
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function fingerprint(path: string, anchor: string): string {
  // Normalize each line on its own and keep their order, so whitespace
  // collapsing can't merge the before / cited / after lines into one string.
  const lines = JSON.stringify(anchor.split('\n').map(norm));
  return createHash('sha256').update(`${path}\n${lines}`).digest('hex').slice(0, 16);
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
