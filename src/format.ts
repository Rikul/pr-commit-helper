import type { Severity } from './config';
import type { PlacedFinding } from './findings';

export const REVIEW_MARKER = '<!-- pr-commit-helper:review -->';
export const findingMarker = (fp: string) => `<!-- pr-commit-helper:finding:${fp} -->`;
const FINDING_MARKER_RE = /<!-- pr-commit-helper:finding:([0-9a-f]+) -->/g;

export function markersIn(text: string): string[] {
  return [...text.matchAll(FINDING_MARKER_RE)].map((m) => m[1]!);
}

const ICONS: Record<Severity, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function fence(code: string): string {
  // Use a longer fence than any backtick run inside the code.
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

export function formatComment(f: PlacedFinding): string {
  const parts = [`**${ICONS[f.severity]} ${cap(f.severity)} · ${f.category}** — ${f.title}`, '', f.body.trim()];
  if (f.suggestion !== undefined && f.suggestion !== null) {
    const code = f.suggestion.replace(/\n$/, '');
    const fe = fence(code);
    parts.push('', `${fe}suggestion`, code, fe);
  }
  parts.push('', findingMarker(f.fingerprint));
  return parts.join('\n');
}

export interface SummaryInput {
  summaries: string[];
  posted: PlacedFinding[];
  offDiff: PlacedFinding[];
  alreadyReported: number;
  belowThreshold: number;
  skippedFiles: { path: string; reason: string }[];
  errors: string[];
  model: string;
  effort: string;
  inputTokens: number;
  outputTokens: number;
}

export function countBySeverity(findings: { severity: Severity }[]): string {
  const order: Severity[] = ['critical', 'high', 'medium', 'low'];
  const parts = order
    .map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${ICONS[s]} ${n} ${s}`);
  return parts.length ? parts.join(' · ') : 'none';
}

export function formatSummary(s: SummaryInput): string {
  const total = s.posted.length + s.offDiff.length;
  const lines: string[] = ['## PR Commit Helper review', ''];

  const summary = s.summaries.filter(Boolean).join('\n\n').trim();
  if (summary) lines.push(summary, '');

  lines.push(total ? `**New findings:** ${countBySeverity([...s.posted, ...s.offDiff])}` : '**No new issues found.**');
  const notes: string[] = [];
  if (s.alreadyReported) notes.push(`${s.alreadyReported} already reported earlier`);
  if (s.belowThreshold) notes.push(`${s.belowThreshold} below min_severity`);
  if (notes.length) lines.push(`<sub>Not repeated: ${notes.join(', ')}.</sub>`);

  if (s.offDiff.length) {
    lines.push('', '<details><summary>Findings outside the changed lines</summary>', '');
    for (const f of s.offDiff) {
      lines.push(
        `- ${ICONS[f.severity]} **${f.title}** — \`${f.path}:${f.line}\` ${findingMarker(f.fingerprint)}`,
        `  ${f.body.trim().replace(/\n/g, '\n  ')}`,
      );
      if (f.suggestion !== undefined && f.suggestion !== null) {
        const code = f.suggestion.replace(/\n$/, '');
        const fe = fence(code);
        lines.push('', `  Suggested change:`, `  ${fe}`, ...code.split('\n').map((l) => `  ${l}`), `  ${fe}`);
      }
    }
    lines.push('', '</details>');
  }

  if (s.skippedFiles.length) {
    lines.push('', `<details><summary>Skipped files (${s.skippedFiles.length})</summary>`, '');
    for (const f of s.skippedFiles.slice(0, 100)) lines.push(`- \`${f.path}\` — ${f.reason}`);
    if (s.skippedFiles.length > 100) lines.push(`- …and ${s.skippedFiles.length - 100} more`);
    lines.push('', '</details>');
  }

  if (s.errors.length) {
    lines.push('', '> [!WARNING]', '> Part of the diff could not be reviewed:');
    for (const e of s.errors) lines.push(`> - ${e}`);
  }

  const tokens = s.inputTokens || s.outputTokens ? ` · ${s.inputTokens} in / ${s.outputTokens} out tokens` : '';
  lines.push('', `<sub>Model: \`${s.model}\` · effort: ${s.effort}${tokens}</sub>`, REVIEW_MARKER);
  return lines.join('\n');
}
