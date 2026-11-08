import * as core from '@actions/core';

export const PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const DEFAULT_MODELS: Record<Provider, string | undefined> = {
  anthropic: 'claude-opus-5-5',
  openai: undefined,
  gemini: undefined,
};

export const DEFAULT_EXCLUDES = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/uv.lock',
  '**/Pipfile.lock',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/go.sum',
  'dist/**',
  'build/**',
  'vendor/**',
  '**/node_modules/**',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.snap',
];

export interface Config {
  provider: Provider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  effort: Effort;
  maxTokens: number;
  temperature?: number;
  anthropicFallback: boolean;
  githubToken: string;
  prNumber?: number;
  include: string[];
  exclude: string[];
  maxFiles: number;
  maxDiffTokens: number;
  minSeverity: Severity;
  reviewEvent: 'COMMENT' | 'REQUEST_CHANGES';
  failOnSeverity: Severity | 'none';
  customInstructions: string;
  language: string;
  skipDraft: boolean;
  dryRun: boolean;
  /** PR comment that starts a review on demand, e.g. "/review". */
  reviewCommand: string;
  /** author_association values allowed to use the review command. */
  allowedCommenters: string[];
}

/** Reads an input. Exposed for tests so they can inject values. */
export type InputReader = (name: string) => string;

const actionsInput: InputReader = (name) => core.getInput(name);

export function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  const v = value.trim().toLowerCase();
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`Input "${name}" must be one of ${allowed.join(', ')} (got "${value}").`);
  }
  return v as T;
}

function positiveInt(name: string, value: string, fallback: number): number {
  if (!value.trim()) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Input "${name}" must be a positive integer (got "${value}").`);
  }
  return n;
}

function bool(value: string, fallback: boolean): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return fallback;
  return ['true', '1', 'yes', 'on'].includes(v);
}

export function loadConfig(read: InputReader = actionsInput): Config {
  const provider = oneOf('provider', read('provider') || 'anthropic', PROVIDERS);

  const apiKey = read('api_key').trim();
  if (!apiKey) {
    throw new Error('Input "api_key" is required. Pass it from a repository secret.');
  }

  const model = read('model').trim() || DEFAULT_MODELS[provider];
  if (!model) {
    throw new Error(`Input "model" is required when provider is "${provider}".`);
  }

  const tempRaw = read('temperature').trim();
  let temperature: number | undefined;
  if (tempRaw) {
    temperature = Number(tempRaw);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new Error(`Input "temperature" must be a number between 0 and 2 (got "${tempRaw}").`);
    }
  }

  const prRaw = read('pr_number').trim();
  const prNumber = prRaw ? positiveInt('pr_number', prRaw, 0) : undefined;

  const reviewEvent = (read('review_event').trim().toUpperCase() || 'COMMENT') as Config['reviewEvent'];
  if (reviewEvent !== 'COMMENT' && reviewEvent !== 'REQUEST_CHANGES') {
    throw new Error(`Input "review_event" must be COMMENT or REQUEST_CHANGES (got "${reviewEvent}").`);
  }

  const fallbackRaw = read('anthropic_fallback').trim().toLowerCase() || 'default';
  if (fallbackRaw !== 'default' && fallbackRaw !== 'none') {
    throw new Error(`Input "anthropic_fallback" must be "default" or "none" (got "${fallbackRaw}").`);
  }

  return {
    provider,
    apiKey,
    model,
    baseUrl: read('base_url').trim() || undefined,
    effort: oneOf('effort', read('effort') || 'medium', EFFORTS),
    maxTokens: positiveInt('max_tokens', read('max_tokens'), 32000),
    temperature,
    anthropicFallback: fallbackRaw === 'default',
    githubToken: read('github_token').trim(),
    prNumber,
    include: splitList(read('include')),
    exclude: [...DEFAULT_EXCLUDES, ...splitList(read('exclude'))],
    maxFiles: positiveInt('max_files', read('max_files'), 50),
    maxDiffTokens: positiveInt('max_diff_tokens', read('max_diff_tokens'), 100000),
    minSeverity: oneOf('min_severity', read('min_severity') || 'low', SEVERITIES),
    reviewEvent,
    failOnSeverity: oneOf('fail_on_severity', read('fail_on_severity') || 'none', [
      'none',
      ...SEVERITIES,
    ] as const),
    customInstructions: read('custom_instructions').trim(),
    language: read('language').trim() || 'English',
    skipDraft: bool(read('skip_draft'), true),
    dryRun: bool(read('dry_run'), false),
    reviewCommand: reviewCommand(read('review_command')),
    allowedCommenters: (splitList(read('allowed_commenters')).length
      ? splitList(read('allowed_commenters'))
      : ['OWNER', 'MEMBER']
    ).map((s) => s.toUpperCase()),
  };
}

function reviewCommand(value: string): string {
  const v = value.trim() || '/review';
  if (/\s/.test(v)) throw new Error(`Input "review_command" must be a single word such as /review (got "${value}").`);
  return v;
}

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}
