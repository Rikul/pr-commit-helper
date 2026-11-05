import { minimatch } from 'minimatch';

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => minimatch(path, p, { dot: true, matchBase: !p.includes('/') }));
}

export interface ChangedFile {
  filename: string;
  previous_filename?: string;
  status: string;
  patch?: string;
}

export interface FilterResult<T> {
  selected: T[];
  skipped: { path: string; reason: string }[];
}

export function filterFiles<T extends ChangedFile>(
  files: T[],
  opts: { include: string[]; exclude: string[]; maxFiles: number },
): FilterResult<T> {
  const selected: T[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const f of files) {
    if (f.status === 'removed') {
      skipped.push({ path: f.filename, reason: 'deleted' });
    } else if (!f.patch) {
      skipped.push({ path: f.filename, reason: 'binary or diff too large' });
    } else if (opts.include.length && !matchesAny(f.filename, opts.include)) {
      skipped.push({ path: f.filename, reason: 'not in include' });
    } else if (matchesAny(f.filename, opts.exclude)) {
      skipped.push({ path: f.filename, reason: 'excluded' });
    } else if (selected.length >= opts.maxFiles) {
      skipped.push({ path: f.filename, reason: `over max_files (${opts.maxFiles})` });
    } else {
      selected.push(f);
    }
  }
  return { selected, skipped };
}
