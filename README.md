# turn-progress

프롬프트 위에 지금 턴의 진행 상태를 바 한 줄로 보여주는 Claude Code 모드입니다. 턴은 요청 → 생각 → 작업 → 답변 순서로 진행됩니다.

- 구간 세 개(생각 · 작업 · 답변)로 나뉜 픽셀 바, 도구 호출마다 틱 하나
- 왼쪽에 작업 제목을 표시합니다. 긴 요청은 Haiku가 2~5단어로 요약합니다(턴당 약 100토큰).
- pill에 지금 단계와 위치(`작업 중 2/3`)를 표시하고, 오른쪽에 경과 시간을 표시
- 서브에이전트는 바 아래 상태 스트립으로 표시
- 턴이 끝난 뒤 틱에 마우스를 올리면 `Edit · register.tsx · 0.8s` 같은 툴팁이 나옵니다.
- 질문·승인 대기는 amber, 오류는 red, 중단은 grey, 완료는 green
- 모델 도구나 프롬프트 규칙을 쓰지 않아, 토큰이 드는 곳은 제목 요약뿐

## 설치 (마켓플레이스)

Claude Code에서:

```
/plugin marketplace add Dan-Millie-Front/turn-progress
/plugin install turn-progress@millie-mods
```

함수 훅 모드를 쓰므로 Claude Code 2.1.286 이상이 필요합니다. 긴 요청의 제목 요약에 Haiku를 턴당 약 100토큰 씁니다.

## 로컬 설치 (개발용)

```bash
claude --plugin-dir ~/Github/turn-progress
```

데스크톱 앱에서 항상 켜려면 `~/.claude/settings.json`에 아래를 추가합니다.

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/Github/turn-progress" } }
```

## 명령

- `/turnbar` 표시/숨김
- `/turnbar-clear` 바 제거

## 개발

```bash
claude plugin validate .
claude plugin test .
npx -y -p typescript@5.6 tsc -p .
```

자세한 명세는 [docs/SPEC.md](docs/SPEC.md)에 있습니다.

UI는 MIT 라이선스인 [plan-progress](https://github.com/zycck/claude-mods)(Kirill Serditov)에서 가져와 고쳤습니다.
