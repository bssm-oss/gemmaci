# Gemma GitHub Action Reviewer

This repository contains a GitHub Actions pull request reviewer that runs a Gemma-style model on GitHub-hosted runners. It is intended as a lower-cost replacement for the core CI review behavior teams often use CodeRabbit for:

- PR-level summary review
- Bounded inline comments on changed lines
- Failing checks for serious findings
- Best-effort model/runtime caching to reduce cold-start cost

## Current Design

The workflow is `.github/workflows/gemma-review.yml` and runs on `pull_request` events. It uses three jobs:

1. `prepare`: checks out trusted base-branch reviewer code, reads the PR diff as data, filters files, and uploads `review-input.json`.
2. `review`: checks out trusted base-branch reviewer code, starts Ollama with `gemma3:1b`, reviews chunks, and uploads `review-output.json`.
3. `publish`: checks out trusted base-branch reviewer code, validates both artifacts as hostile input, posts a managed summary and bounded inline comments, and fails on high/critical findings.

`pull_request_target` is intentionally not used by default.

## Security Model

The reviewer treats all PR-controlled data as untrusted:

- PR diffs are data only.
- PR branch files are not used as reviewer scripts.
- Model output is hostile until schema-validated.
- `review-input.json` and `review-output.json` are hostile artifacts.
- The publishing job runs only trusted base-branch code and revalidates paths and changed lines before posting comments.

For fork PRs, GitHub may downgrade `GITHUB_TOKEN` permissions. In that case the reviewer degrades to job summaries, annotations, and artifacts instead of assuming comments can always be posted.

## Configuration

Set these environment variables in the workflow to tune behavior:

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMMA_REVIEW_MODEL` | `gemma3:1b` | Ollama model tag |
| `GEMMA_REVIEW_OLLAMA_VERSION` | `0.12.10` | Pinned Ollama release version |
| `GEMMA_REVIEW_OLLAMA_LINUX_AMD64_SHA256` | `8f4bf70a9856a34ba71355745c2189a472e2691a020ebd2e242a58e4d2094722` | Expected SHA-256 for the pinned Linux amd64 Ollama archive |
| `GEMMA_REVIEW_CACHE_VERSION` | `v2` | Manual cache bust key |
| `GEMMA_REVIEW_MAX_DIFF_BYTES` | `200000` | Total included diff budget |
| `GEMMA_REVIEW_MAX_FILE_BYTES` | `60000` | Per-file diff budget |
| `GEMMA_REVIEW_MAX_CHUNK_BYTES` | `24000` | Per-model-call chunk budget |
| `GEMMA_REVIEW_MAX_INLINE_COMMENTS` | `20` | Max inline comments per run |
| `GEMMA_REVIEW_MIN_CONFIDENCE` | `0.6` | Minimum confidence required for inline findings |
| `GEMMA_REVIEW_TIMEOUT_MS` | `600000` | Model call timeout |
| `GEMMA_REVIEW_FAIL_ON_SEVERITY` | `critical,high` | Severities that fail the check |
| `GEMMA_REVIEW_LANGUAGE` | `ko` | Review output language |

## Local Verification

Run the test suite:

```bash
node --test scripts/gemma-review/test/*.test.mjs
```

Run the fixture-based end-to-end dry run:

```bash
node scripts/gemma-review/prepare-diff.mjs \
  --event scripts/gemma-review/test/fixtures/pull_request_event.json \
  --diff scripts/gemma-review/test/fixtures/sample.diff \
  --output /tmp/review-input.json

node scripts/gemma-review/review.mjs \
  --input /tmp/review-input.json \
  --output /tmp/review-output.json \
  --mock-model scripts/gemma-review/test/fixtures/model-output.json

node scripts/gemma-review/publish-comments.mjs \
  --review-input /tmp/review-input.json \
  --input /tmp/review-output.json \
  --dry-run \
  --no-fail
```

The final command prints the summary, inline comments that would be posted, and whether the check would fail.

## Bootstrap Caveat

Because the workflow deliberately runs reviewer scripts from the base branch, the first PR that introduces this reviewer cannot fully validate live base-branch execution in GitHub Actions. Verify that first change locally with fixtures, merge it, then open a follow-up PR to validate the live PR-review surface.

## Known Limits

- GitHub-hosted runners are CPU-only by default, so large Gemma models are not suitable as defaults.
- Caches are best-effort and may be evicted.
- Cold starts can be slow because Ollama and model artifacts may need to download. The workflow caches `~/.ollama/models` and the pinned Ollama release archive under `~/.cache/gemma-review/ollama-downloads`, then verifies SHA-256 and extracts to a fresh temp directory before execution.
- If warm-cache reviews routinely exceed the configured timeout or review quality is too weak, switch the runtime to llama.cpp GGUF or consider self-hosted runners.

## Review Quality Controls

The model is asked to return only high-signal findings with a category, severity, confidence, concrete evidence, and a recommended next action. Evidence must quote an exact changed-line code fragment, so well-formed but ungrounded findings are dropped before publishing. Findings below `GEMMA_REVIEW_MIN_CONFIDENCE` are also dropped, and publish-time validation repeats the same path/line/severity/evidence/body/recommendation checks before using the GitHub API.

The sticky summary comment includes CodeRabbit-style review status details: finding counts, highest severity, confidence threshold, category counts, reviewed/skipped file counts, included diff bytes, and a collapsible skipped-file list.
