# Gemma Review Demo

이 데모는 `bssm-oss/gemmaci` 저장소에서 실제 GitHub Actions PR 리뷰가 실행된 증거를 정리합니다.

## Live targets

- PR: https://github.com/bssm-oss/gemmaci/pull/2
- Actions run: https://github.com/bssm-oss/gemmaci/actions/runs/26009211725
- Summary comment: https://github.com/bssm-oss/gemmaci/pull/2#issuecomment-4473499320
- Inline finding: https://github.com/bssm-oss/gemmaci/pull/2#discussion_r3255933478

## What happened

1. Smoke PR added `src/math.js` with `unsafeDivide`.
2. `Prepare diff` ran in GitHub Actions and produced `review-input.json`.
3. `Review with Gemma` installed pinned Ollama, pulled `gemma3:1b`, reviewed the diff, and uploaded `review-output.json`.
4. `Publish review` posted a PR summary and inline comment.
5. Because the reviewer found a `high` severity issue, `Publish review` failed by policy.

## Evidence

- GitHub Actions bot posted an inline comment on `src/math.js:2`.
- The comment title was `HIGH: 0 나눗셈 검증 누락`.
- The comment included `Category`, `Confidence`, `Evidence`, and `Recommendation`.
- The failing check is expected because `GEMMA_REVIEW_FAIL_ON_SEVERITY=critical,high`.

## Included data files

- `pr-2-demo-data.json`: PR status, comments, checks, files.
- `run-26009211725-demo-data.json`: Actions run and job details.
- `pr-2-inline-comments.json`: inline PR comments, including the Gemma reviewer comment.
- `run-26009211725-artifacts.json`: Actions artifacts from the run.

## Optional video capture

On macOS, record the PR and Actions run with:

```bash
mkdir -p demo
open -a "Google Chrome" "https://github.com/bssm-oss/gemmaci/pull/2"
sleep 3
screencapture -v -V 45 -k -D 1 "demo/gemma-review-demo.mov"
ffmpeg -y -i "demo/gemma-review-demo.mov" \
  -vf "scale=1280:-2,fps=30" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  "demo/gemma-review-demo.mp4"
```
