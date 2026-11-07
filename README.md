# PR Commit Helper

A GitHub Action that reviews pull requests with an LLM and posts what it finds as a single PR review: a short summary plus inline comments on the changed lines.

- **Providers:** Anthropic (Claude), any OpenAI-compatible endpoint (OpenAI, Azure, OpenRouter, Ollama, vLLM, …), and Google Gemini.
- **Configurable:** model, reasoning effort, severity threshold, file filters and extra instructions.
- **Low noise:** looks for bugs, security and reliability problems, not style. Re-runs on new pushes don't repeat comments already posted.
- **Safe on fork PRs:** the action never checks out or runs PR code. It reads the diff through the GitHub API.

## Quick start

1. Add your provider's key as a repository secret (**Settings → Secrets and variables → Actions**), e.g. `ANTHROPIC_API_KEY`.
2. Add `.github/workflows/pr-review.yml`:

```yaml
name: AI PR review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

# One review at a time per PR; a newer push cancels the older run.
concurrency:
  group: pr-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: Rikul/pr-commit-helper@main
        with:
          api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Keep the `concurrency` block: two runs on the same PR at once can both post the same findings.

That's it. The next PR gets a review from `claude-opus-5-5` at `medium` effort.

> Pin to a commit SHA instead of `@main` if you want updates to this action to arrive only when you choose.

## Provider examples

**Anthropic**

```yaml
- uses: Rikul/pr-commit-helper@main
  with:
    provider: anthropic
    api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    model: claude-sonnet-5-5
    effort: high
```

**OpenAI**

```yaml
- uses: Rikul/pr-commit-helper@main
  with:
    provider: openai
    api_key: ${{ secrets.OPENAI_API_KEY }}
    model: <openai model id>
    effort: medium
```

**OpenAI-compatible (OpenRouter, Azure, Ollama, vLLM, …)**

```yaml
- uses: Rikul/pr-commit-helper@main
  with:
    provider: openai
    base_url: https://openrouter.ai/api/v1
    api_key: ${{ secrets.OPENROUTER_API_KEY }}
    model: <model id on that service>
```

**Google Gemini**

```yaml
- uses: Rikul/pr-commit-helper@main
  with:
    provider: gemini
    api_key: ${{ secrets.GEMINI_API_KEY }}
    model: <gemini model id>
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `provider` | `anthropic` | `anthropic`, `openai` (any OpenAI-compatible API) or `gemini`. |
| `api_key` | **required** | Provider API key. Always pass it from a secret. |
| `model` | `claude-opus-5-5` for anthropic | Model ID. Required for `openai` and `gemini`. |
| `base_url` | | Custom API base URL (gateway, proxy, self-hosted server). |
| `effort` | `medium` | `low`, `medium`, `high`, `xhigh`, `max`. See [Effort](#effort). |
| `max_tokens` | `32000` | Max output tokens per LLM call (includes reasoning on most providers). |
| `temperature` | | Sampling temperature. Leave empty; recent Claude models reject it. |
| `anthropic_fallback` | `default` | Anthropic only. `default` lets the Claude API re-run a declined request on a fallback model. `none` turns this off. Not used with `base_url`. |
| `github_token` | `${{ github.token }}` | Token used to read the PR and post the review. |
| `pr_number` | | PR to review on events other than `pull_request` (e.g. `workflow_dispatch`). |
| `include` | | Globs (comma/newline separated). Only matching files are reviewed. |
| `exclude` | | Extra globs to skip, added to the built-in list (lockfiles, `dist/**`, `build/**`, `vendor/**`, `*.min.js`, `*.map`, `*.snap`, …). |
| `max_files` | `50` | Files beyond this are listed as skipped. |
| `max_diff_tokens` | `100000` | Approximate diff size per LLM call. Larger diffs are split into parts. |
| `min_severity` | `low` | Lowest severity to post: `low`, `medium`, `high`, `critical`. |
| `review_event` | `COMMENT` | `REQUEST_CHANGES` requests changes when a new finding is `high` or `critical`. |
| `fail_on_severity` | `none` | Fail the job if any finding is at or above this severity, whatever `min_severity` is. Also fails if part of the diff couldn't be reviewed. |
| `custom_instructions` | | Extra guidance for the reviewer (conventions, focus areas). |
| `language` | `English` | Language for review comments. |
| `skip_draft` | `true` | Don't review draft PRs. Add `ready_for_review` to the triggers to review them once marked ready. |
| `dry_run` | `false` | Print the review to the job log instead of posting it. |

## Outputs

| Output | Description |
|---|---|
| `findings_count` | Number of new findings in this run. |
| `findings_json` | JSON array of those findings (`path`, `line`, `severity`, `category`, `title`, `body`, …). |
| `review_url` | URL of the posted review, or empty if none was posted. |

## Effort

`effort` is mapped to each provider's own reasoning control:

| Provider | How `effort` is applied |
|---|---|
| Anthropic | `output_config.effort` (`low` … `max`). Current Claude models think adaptively, and effort sets how deeply. |
| OpenAI-compatible | `reasoning_effort`. `xhigh`/`max` are sent as `high`. If the server rejects it (non-reasoning models, some gateways), the request is retried without it. |
| Gemini | Gemini 3+: `thinkingLevel` (LOW/MEDIUM/HIGH). Gemini 2.x: `thinkingBudget` of 1k / 8k / 16k / 24k / 32k tokens. |

Higher effort usually finds more subtle bugs and costs more tokens. `medium` is a good default; use `high` for critical repositories.

## How it works

1. Lists the PR's changed files through the API and skips binary, excluded and generated files. Deleted files are reviewed too, and findings on them go in the review summary.
2. Annotates each diff line with its line number in the new file, so the model can point at exact lines.
3. Sends the diff (split into parts if large) with the PR title and description to the model, which returns structured JSON findings.
4. Checks each finding against the diff. Findings on a line close to a changed line are moved onto it. The rest are listed in the review summary under "Findings outside the changed lines".
5. Leaves out findings already posted on this PR. Each comment carries a hidden fingerprint.
6. Posts one review on the head commit. If GitHub rejects an inline position, the findings go into the review body instead.

A push that produces no new findings doesn't post a new review.

## Fork PRs and `pull_request_target`

On `pull_request`, GitHub doesn't give workflows from forks access to secrets, so the review step fails for fork PRs. If you need fork PRs reviewed, use `pull_request_target`:

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
```

This action doesn't check out or execute PR code, which is what makes `pull_request_target` dangerous. **Don't add an `actions/checkout` of the PR head plus build or test steps in the same job.** Keep in mind that the PR author controls the diff the model reads. The prompt tells the model to treat it as data, but don't give this job any extra permissions.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build   # bundles to dist/index.js (git-ignored; don't commit it)
```

`dist/` is git-ignored and never part of a PR. Workflows run `dist/index.js` directly from `@main`, so `.github/workflows/build-dist.yml` rebuilds it after every push to `main` and commits the result there.

## License

MIT
