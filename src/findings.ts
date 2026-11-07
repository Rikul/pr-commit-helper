import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SEVERITIES, type Severity, severityRank } from './config';
import { commentableLines, hunkIndexOf, lineText, type FileDiff } from './diff';

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
    if (!file) return { ...offDiff, fingerprint: fingerprint(path, f.title, `L${f.line}`) };

    const lines = commentableLines(file);
    let line = f.line;
    if (!lines.has(line)) {
      const nearest = [...lines]
        .filter((l) => Math.abs(l - line) <= SNAP_DISTANCE)
        .sort((a, b) => Math.abs(a - line) - Math.abs(b - line))[0];
      if (nearest === undefined) return { ...offDiff, fingerprint: fingerprint(path, f.title, `L${f.line}`) };
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

    // Keyed on the cited code rather than its line number, so the same finding
    // keeps its fingerprint when other edits shift lines between pushes.
    const anchor = lineText(file, line) ?? `L${line}`;
    return { ...f, path, line, start_line, suggestion, inline: true, fingerprint: fingerprint(path, f.title, anchor) };
  });
}

export function fingerprint(path: string, title: string, anchor: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${path}\n${norm(title)}\n${norm(anchor)}`).digest('hex').slice(0, 16);
}

export function filterBySeverity<T extends { severity: Severity }>(findings: T[], min: Severity): T[] {
  return findings.filter((f) => severityRank(f.severity) >= severityRank(min));
}

/** Removes duplicates within the list (same fingerprint), keeping the most severe. */
export function dedupe<T extends PlacedFinding>(findings: T[]): T[] {
  const best = new Map<string, T>();
  for (const f of findings) {
    const prev = best.get(f.fingerprint);
    if (!prev || severityRank(f.severity) > severityRank(prev.severity)) best.set(f.fingerprint, f);
  }
  return [...best.values()].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.path.localeCompare(b.path) || a.line - b.line,
  );
}
