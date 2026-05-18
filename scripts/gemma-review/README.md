# @bssm-oss/gemma-reviewer

Gemma/Ollama 기반 GitHub Actions PR 리뷰어 CLI입니다. 보통은 저장소 루트의 reusable workflow를 사용하는 것이 가장 쉽고, 이 패키지는 로컬 검증이나 커스텀 CI에서 같은 prepare/review/publish 단계를 실행할 때 사용합니다.

## Commands

```bash
gemma-review-prepare --output review-input.json
gemma-review-run --input review-input.json --output review-output.json
gemma-review-publish --review-input review-input.json --input review-output.json
```

## Requirements

- Node.js 20 이상
- review 단계에서 실행 중인 Ollama API (`http://127.0.0.1:11434` 기본값)
- publish 단계에서 `GITHUB_TOKEN`

자세한 설치와 GitHub Actions 사용법은 저장소 루트 `README.md`를 참고하세요.
