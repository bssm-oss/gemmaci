# Gemma GitHub Actions PR 리뷰어

이 저장소는 GitHub Actions에서 Gemma 계열 모델을 실행해 pull request를 리뷰하는 저비용 코드 리뷰 자동화입니다. CodeRabbit에서 자주 쓰는 핵심 CI 리뷰 기능을 대체하거나 보완하는 것을 목표로 합니다.

- PR 전체 요약 댓글
- 변경된 라인에 대한 inline review comment
- 심각한 이슈 발견 시 check 실패 처리
- Ollama runtime/model cache를 통한 cold start 비용 절감
- evidence, confidence, recommendation 기반의 고신뢰 리뷰 출력

## 현재 동작 방식

워크플로우 파일은 `.github/workflows/gemma-review.yml`입니다. `pull_request` 이벤트에서 실행되며 세 개의 job으로 나뉩니다.

1. `prepare`
   - trusted base branch의 reviewer code를 checkout합니다.
   - PR diff를 코드가 아니라 데이터로 읽습니다.
   - binary, lockfile, generated/vendor, oversized file을 필터링합니다.
   - `review-input.json` artifact를 업로드합니다.

2. `review`
   - trusted base branch의 reviewer code를 다시 checkout합니다.
   - pinned Ollama를 설치하고 SHA-256을 검증합니다.
   - `gemma3:1b` 모델로 diff chunk를 리뷰합니다.
   - 모델 결과를 schema 검증하고 `review-output.json` artifact를 업로드합니다.

3. `publish`
   - trusted base branch의 reviewer code를 다시 checkout합니다.
   - `review-input.json`, `review-output.json`을 hostile artifact로 보고 다시 검증합니다.
   - PR summary comment를 생성하거나 갱신합니다.
   - 유효한 changed line에만 inline comment를 게시합니다.
   - `critical` 또는 `high` finding이 있으면 check를 실패시킵니다.

기본적으로 `pull_request_target`은 사용하지 않습니다. PR 작성자가 바꾼 workflow/script가 write 권한으로 실행되는 위험을 피하기 위해서입니다.

## 실제 CI 검증 상태

이 저장소에서는 로컬 dry-run만 한 것이 아니라 GitHub Actions에서 실제 PR을 열어 검증했습니다.

- 테스트 PR: `https://github.com/bssm-oss/gemmaci/pull/2`
- 실제 workflow run: `https://github.com/bssm-oss/gemmaci/actions/runs/26009436921`
- `Prepare diff`: 성공
- `Review with Gemma`: 성공
- `Publish review`: 실패

여기서 `Publish review` 실패는 오류가 아니라 의도된 동작입니다. smoke PR에 `unsafeDivide`가 들어 있었고, reviewer가 `high` severity finding을 만들어 `GEMMA_REVIEW_FAIL_ON_SEVERITY=critical,high` 정책대로 check를 실패시켰습니다.

실제로 GitHub Actions bot이 PR에 다음을 게시한 것도 확인했습니다.

- PR summary comment
- `src/math.js:1` inline comment
- finding 내용: `HIGH: 0 나눗셈 검증 누락`
- evidence, confidence, recommendation 포함

즉, 현재 검증된 상태는 다음과 같습니다.

- 로컬 fixture 검증: 완료
- GitHub-hosted runner에서 workflow 실행: 완료
- Ollama 설치 및 모델 리뷰 job 실행: 완료
- GitHub PR summary comment 게시: 완료
- GitHub PR inline comment 게시: 완료
- 심각 finding 감지 시 CI 실패 처리: 완료

## 보안 모델

이 reviewer는 PR에서 온 모든 데이터를 신뢰하지 않습니다.

- PR diff는 실행하지 않고 데이터로만 취급합니다.
- PR branch의 파일은 reviewer script로 사용하지 않습니다.
- model output은 schema 검증 전까지 hostile data로 취급합니다.
- `review-input.json`, `review-output.json` artifact도 hostile input으로 재검증합니다.
- publish job은 write permission을 가지므로 trusted base branch code만 실행합니다.
- publish 직전에 GitHub API에서 현재 PR head와 changed line을 다시 확인합니다.

fork PR에서는 GitHub가 `GITHUB_TOKEN` 권한을 낮출 수 있습니다. 이 경우 comment 게시가 안 될 수 있으므로 job summary와 artifact 중심으로 degrade됩니다.

## 설정

워크플로우의 env 값으로 동작을 조정할 수 있습니다.

| 변수 | 기본값 | 설명 |
|---|---:|---|
| `GEMMA_REVIEW_MODEL` | `gemma3:1b` | Ollama model tag |
| `GEMMA_REVIEW_OLLAMA_VERSION` | `0.12.10` | 고정 Ollama release version |
| `GEMMA_REVIEW_OLLAMA_LINUX_AMD64_SHA256` | `8f4bf70a9856a34ba71355745c2189a472e2691a020ebd2e242a58e4d2094722` | pinned Linux amd64 Ollama archive SHA-256 |
| `GEMMA_REVIEW_CACHE_VERSION` | `v2` | cache bust용 수동 버전 |
| `GEMMA_REVIEW_MAX_DIFF_BYTES` | `200000` | 전체 included diff budget |
| `GEMMA_REVIEW_MAX_FILE_BYTES` | `60000` | 파일별 diff budget |
| `GEMMA_REVIEW_MAX_CHUNK_BYTES` | `24000` | 모델 호출 1회당 chunk budget |
| `GEMMA_REVIEW_DIFF_CONTEXT_LINES` | `3` | 모델 추론에 포함할 주변 diff context line 수 |
| `GEMMA_REVIEW_MAX_INLINE_COMMENTS` | `20` | 실행 1회당 최대 inline comment 수 |
| `GEMMA_REVIEW_MIN_CONFIDENCE` | `0.6` | inline finding 최소 confidence |
| `GEMMA_REVIEW_DETERMINISTIC_RULES` | `true` | 명백한 high-signal deterministic safety finding 활성화 |
| `GEMMA_REVIEW_TIMEOUT_MS` | `600000` | 모델 호출 timeout |
| `GEMMA_REVIEW_FAIL_ON_SEVERITY` | `critical,high` | check를 실패시킬 severity 목록 |
| `GEMMA_REVIEW_LANGUAGE` | `ko` | 리뷰 출력 언어 |

## 로컬 검증 방법

테스트 전체 실행:

```bash
node --test scripts/gemma-review/test/*.test.mjs
```

fixture 기반 end-to-end dry-run:

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

마지막 명령은 실제 GitHub API에 게시하지 않고, 게시될 summary/inline comment와 check 실패 여부를 JSON으로 출력합니다.

## 쉽게 설치해서 쓰는 방법

가장 쉬운 방식은 이 저장소의 reusable workflow를 호출하는 것입니다.

```yaml
name: Gemma Review

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions: {}

jobs:
  gemma-review:
    uses: bssm-oss/gemmaci/.github/workflows/gemma-review.yml@main
    with:
      model: gemma3:1b
      language: ko
      max-inline-comments: 20
      min-confidence: '0.6'
```

npm 패키지로도 배포할 수 있도록 `scripts/gemma-review/package.json`에 CLI bin을 준비했습니다.

```bash
npm exec @bssm-oss/gemma-reviewer -- gemma-review-prepare --output review-input.json
npm exec @bssm-oss/gemma-reviewer -- gemma-review-run --input review-input.json --output review-output.json
npm exec @bssm-oss/gemma-reviewer -- gemma-review-publish --review-input review-input.json --input review-output.json
```

현재 이 환경은 npm 로그인이 되어 있지 않아 실제 `npm publish`는 하지 않았습니다. publish 전 검증은 다음 명령으로 가능합니다.

```bash
npm --prefix scripts/gemma-review run pack:check
```

## 리뷰 품질 제어

모델은 high-signal finding만 JSON으로 반환하도록 지시받습니다. 각 finding에는 다음 필드가 필요합니다.

- `category`
- `severity`
- `confidence`
- `title`
- `evidence`
- `body`
- `recommendation`
- 선택적 `suggestion`

`evidence`는 실제 changed line의 코드 조각을 그대로 인용해야 합니다. 형식만 맞고 변경 코드에 근거하지 않은 finding은 게시 전에 제거됩니다.

`GEMMA_REVIEW_MIN_CONFIDENCE`보다 낮은 finding도 제거됩니다. publish job에서도 path, line, severity, category, evidence, body, recommendation을 다시 검증합니다.

또한 reviewer에는 작은 deterministic safety pass가 있습니다. 예를 들어 새로 추가된 `unsafeDivide`류 함수가 분모 0 guard 없이 division return을 하면, 모델이 놓쳐도 high-signal finding으로 보강합니다. 이 deterministic finding도 모델 finding과 동일하게 evidence grounding과 publish-time validation을 통과해야만 게시됩니다.

PR summary comment에는 CodeRabbit 스타일의 review status 정보가 포함됩니다.

- inline finding 수
- 최고 severity
- confidence threshold
- category count
- 검토한 파일 수
- 스킵한 파일 수
- included diff bytes
- collapsible skipped-file list

모델 prompt에는 PR 제목/본문도 포함됩니다. 단, PR 본문은 prompt injection 가능성이 있으므로 “untrusted context”로만 쓰고 지시사항으로 따르지 않도록 명시합니다.

## 첫 도입 시 주의점

이 workflow는 의도적으로 base branch의 reviewer script만 실행합니다. 따라서 workflow를 처음 추가하는 PR에서는 GitHub Actions live 표면을 완전히 검증할 수 없습니다.

권장 순서:

1. workflow와 script를 base branch에 먼저 merge합니다.
2. 후속 smoke PR을 엽니다.
3. `Prepare diff`, `Review with Gemma`, `Publish review` job이 실제로 도는지 확인합니다.
4. PR summary와 inline comment가 게시되는지 확인합니다.
5. high/critical finding에서 check가 실패하는지 확인합니다.

이 저장소에서는 위 절차를 `#2` smoke PR로 검증했습니다.

## 알려진 한계

- GitHub-hosted runner는 기본적으로 CPU-only이므로 큰 Gemma 모델은 기본값으로 적합하지 않습니다.
- cache는 best-effort입니다. GitHub가 cache를 evict하면 cold start가 다시 발생할 수 있습니다.
- 첫 실행은 Ollama와 model artifact 다운로드 때문에 느릴 수 있습니다.
- warm-cache 상태에서도 timeout이 자주 발생하거나 리뷰 품질이 부족하면 llama.cpp GGUF 또는 self-hosted runner 전환을 고려해야 합니다.
- 현재 deterministic rule은 일부 명백한 패턴만 보강합니다. 일반적인 코드 품질은 모델 리뷰 품질과 prompt/schema에 의존합니다.
