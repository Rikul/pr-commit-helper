import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDES } from '../src/config';
import { filterFiles, matchesAny } from '../src/filter';
import { formatComment, formatSummary, markersIn } from '../src/format';
import type { PlacedFinding } from '../src/findings';

describe('filterFiles', () => {
  const files = [
    { filename: 'src/a.ts', status: 'modified', patch: '@@' },
    { filename: 'package-lock.json', status: 'modified', patch: '@@' },
    { filename: 'web/app.min.js', status: 'added', patch: '@@' },
    { filename: 'img.png', status: 'added' },
    { filename: 'old.ts', status: 'removed', patch: '@@' },
    { filename: 'src/b.ts', status: 'added', patch: '@@' },
  ];

  it('skips lockfiles, minified and binary files but keeps deleted text files', () => {
    const r = filterFiles(files, { include: [], exclude: DEFAULT_EXCLUDES, maxFiles: 10 });
    expect(r.selected.map((f) => f.filename)).toEqual(['src/a.ts', 'old.ts', 'src/b.ts']);
    expect(r.skipped).toHaveLength(3);
  });

  it('honours include and max_files', () => {
    const r = filterFiles(files, { include: ['src/**'], exclude: [], maxFiles: 1 });
    expect(r.selected.map((f) => f.filename)).toEqual(['src/a.ts']);
    expect(r.skipped.find((s) => s.path === 'src/b.ts')?.reason).toMatch(/max_files/);
  });

  it('matches basename patterns anywhere', () => {
    expect(matchesAny('deep/dir/x.snap', ['*.snap'])).toBe(true);
    expect(matchesAny('dist/index.js', ['dist/**'])).toBe(true);
    expect(matchesAny('src/dist/index.js', ['dist/**'])).toBe(false);
  });
});

const finding: PlacedFinding = {
  path: 'a.ts',
  line: 3,
  severity: 'high',
  category: 'bug',
  title: 'Null deref',
  body: 'Crashes when x is null.',
  suggestion: 'if (x) {\n  ```weird```\n}',
  inline: true,
  fingerprint: 'abc123',
};

describe('format', () => {
  it('renders a comment with a safe suggestion fence and marker', () => {
    const c = formatComment(finding);
    expect(c).toContain('**🟠 High · bug** — Null deref');
    expect(c).toContain('````suggestion');
    expect(markersIn(c)).toEqual(['abc123']);
  });

  it('renders the summary with counts, off-diff findings and markers', () => {
    const s = formatSummary({
      summaries: ['Looks mostly fine.'],
      posted: [finding],
      offDiff: [{ ...finding, inline: false, fingerprint: 'def456', severity: 'low' }],
      alreadyReported: 2,
      belowThreshold: 0,
      skippedFiles: [{ path: 'yarn.lock', reason: 'excluded' }],
      errors: [],
      model: 'm',
      effort: 'medium',
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(s).toContain('🟠 1 high · 🔵 1 low');
    expect(s).toContain('2 already reported earlier');
    expect(s).toContain('yarn.lock');
    expect(markersIn(s)).toEqual(['def456']);
    // Suggestions survive in the body, as a plain code block.
    expect(s).toContain('Suggested change:');
    expect(s).toContain('  ````\n  if (x) {');
    expect(s).not.toContain('suggestion\n');
    expect(s).toContain('<!-- pr-commit-helper:review -->');
  });

  it('says so when there are no findings', () => {
    const s = formatSummary({
      summaries: [],
      posted: [],
      offDiff: [],
      alreadyReported: 0,
      belowThreshold: 0,
      skippedFiles: [],
      errors: [],
      model: 'm',
      effort: 'low',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(s).toContain('No new issues found');
  });
});
