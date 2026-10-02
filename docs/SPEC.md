# turn-progress 구현 명세

한 턴(내가 요청 → Claude가 생각 → 도구로 작업 → 마무리 답변)을 프롬프트 위 **상태 바 한 줄**로 실시간 표시하는 Claude Code 모드.
UI는 [zycck/claude-mods](https://github.com/zycck/claude-mods)의 `plan-progress`를 거의 그대로 가져온다. 픽셀 채움, 상태 pill, 도구 틱, 서브에이전트 스트립, 사운드, Progress 버튼이 그 대상이다.

> 이 문서만으로 새 저장소에서 처음부터 구현할 수 있게 썼다. 부록 A의 소스는 Claude Code **2.1.286**에서 `claude plugin validate`, `tsc --strict`, 헤드리스 실행(모든 훅 정상 종료)까지 확인했다. 그대로 복사해서 시작하면 된다.

---

## 1. 목표와 범위

**한다**
- 메인 대화의 매 턴마다 바 하나를 만들고, 스트리밍 이벤트만 보고 채운다.
- 채움은 세 구간(**생각 → 작업 → 답변**) 비율로 진행하지만 구간 경계선은 그리지 않는다. 지금 구간은 pill의 `n/3`이 알려준다. 도구 호출 하나하나는 짧은 틱으로 표시한다.
- 왼쪽에는 **작업 제목**을 보여준다. 20자 이하 한 줄 프롬프트는 그대로 쓰고, 그보다 길면 Haiku가 2~5단어로 요약한다(턴당 약 100토큰, 약 0.7초). 요약이 오기 전에는 dim `…`을 보여준다.
- pill에는 지금 단계와 단계 위치를 보여준다: `생각 중 1/3` / `작업 중 2/3` / `답변 작성 3/3` / `완료 3/3`. 서브에이전트가 있으면 ` · 에이전트 1/2`를 붙인다. 도구 이름과 호출 수는 글자로 쓰지 않고 트랙 위 틱으로만 보여준다.
- 오른쪽 고정 폭 칸에는 **경과 시간**을 보여준다. 턴 진행률은 미리 알 수 없어서 퍼센트 대신 시간을 쓴다.
- 서브에이전트는 바 아래 상태 스트립으로 그린다. plan-progress와 동일하다.
- 상태는 `running`, `needs_input`(질문, 플랜 승인, 권한 승인 대기), `error`, `stopped`(사용자 중단), `done`.
- 결정이 필요할 때, 오류가 났을 때, 긴 턴(20초 이상)이 끝났을 때 소리를 낸다.

**하지 않는다 (plan-progress와 다른 점)**
- 모델에게 도구를 주지 않고, 시스템 프롬프트에 규칙도 넣지 않는다. 진행 상태는 엔진 이벤트만으로 움직인다. 토큰이 드는 곳은 긴 프롬프트의 제목 요약 한 번(Haiku, 약 100토큰)뿐이다.
- 바 없이 작업하면 거부하는 게이트나 Stop 되돌리기 같은 강제 장치가 없다.
- 단계와 스텝 계획이 없다. 구간은 고정된 세 개다.

---

## 2. 파일 구조

```
turn-progress/                    ← 새 저장소 루트 = 플러그인 폴더
  .claude-plugin/plugin.json
  hooks/hooks.json                ← { "modules": ["./register.tsx"] }
  hooks/register.tsx              ← 모드 본체 (부록 A.4)
  types/index.d.ts                ← $.state 계약 (부록 A.3)
  sounds/decision.wav
  sounds/error.wav
  sounds/done.wav
  tsconfig.json                   ← 편집기·tsc용 (부록 A.5)
  .gitignore
  LICENSE                         ← MIT, 원작자 표기 포함 (11장)
  README.md
```

`.gitignore`:
```
.claude-plugin/types/
node_modules/
*.log
```
`.claude-plugin/types/`는 엔진이 모드를 로드할 때마다 자동으로 쓰는 타입 폴더다. 커밋하지 않는다.

**사운드**: 원본 MIT 저장소의 wav를 그대로 쓰거나 직접 만든 wav(짧은 44.1 kHz 16-bit)로 교체한다.
```bash
cp ~/Github/claude-mods/plugins/plan-progress/sounds/*.wav sounds/
```

---

## 3. 로컬 설치와 개발 루프 (마켓플레이스 없이)

**1) 일회성 실행 (터미널, 가장 단순)**
```bash
claude --plugin-dir ~/Github/turn-progress
```
대화형 세션은 이 폴더를 감시한다. 파일을 저장하면 모듈이 다시 로드된다(`register`가 다시 실행되고 `session.start`도 다시 발생한다). `$.state` 값은 유지되고 모듈 변수는 초기화된다.

**2) 상시 로드 (데스크톱 앱 포함)**: `~/.claude/settings.json`의 `env`에 추가한다(프로젝트 settings는 무시된다).
```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/Github/turn-progress"
  }
}
```
여러 폴더는 `:`로 구분한다(macOS). 앱 같은 장기 실행 호스트에서 핫리로드까지 원하면 `"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"`도 같은 곳에 넣는다.

**3) 대안**: `~/.claude/skills/turn-progress`에 심볼릭 링크를 두면 자동 로드되고 감시도 된다.
```bash
ln -s ~/Github/turn-progress ~/.claude/skills/turn-progress
```

**4) 마켓플레이스로 배포**: 저장소 루트의 `.claude-plugin/marketplace.json`이 저장소 자체(`"source": "./"`)를 플러그인 하나로 등록한다. 같은 `.claude-plugin/` 폴더에 `plugin.json`과 함께 둔다.
```json
{ "name": "dan-mods", "owner": { "name": "Dan" }, "plugins": [{ "name": "turn-progress", "source": "./", "description": "..." }] }
```
설치하는 쪽:
```
/plugin marketplace add Dan-Millie-Front/turn-progress
/plugin install turn-progress@dan-mods
```
새 버전을 낼 때는 `plugin.json`의 `version`을 올리고 push한다. 받는 쪽은 `/plugin marketplace update dan-mods`로 갱신한다.

**검증 루프** (`tests/ui.test.tsx`는 턴 하나를 흉내 낸다. `$.turn.start` → Bash `$.tool.call` → `$.turn.complete` 순서로 이벤트를 일으킨 뒤, 바, 푸터 라벨, 타임라인 패널을 터미널과 데스크톱 두 화면에 띄워 앱이 거부할 트리가 없는지와 제목, 호출 설명, 토큰이 그려졌는지 확인한다. 테스트 쪽 `on`이 엔진 대신 `turn.start`, `turn.complete`, `tool.call`, `ui.render`에 답하고, 시계는 `mock.clock`이다)
```bash
claude plugin test .
```
```bash
claude plugin validate .
```
```bash
npx -y -p typescript@5.6 tsc -p .
```
- 타입 파일: 엔진이 로드할 때 `.claude-plugin/types/claude-code/index.d.ts`를 쓴다. 이 파일이 현재 빌드 API의 정답지이고, 루트 tsconfig가 이걸 확장한다(부록 A.5). 업데이트 후에는 다시 로드하면 새로 쓰인다.
- 디버그: `claude --debug-file ./debug.log`로 실행한 뒤 `grep turn-progress debug.log`. 정상이면 훅마다 `... settled in Nms`가 찍히고, 실패한 훅은 사유와 함께 기록된다.
- 헤드리스 스모크 테스트(함수 훅을 켜야 한다):
```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "Run ls once, then reply in one sentence." --model haiku --plugin-dir . --debug-file ./debug.log --allowedTools "Bash(ls:*)"
```
  주의: `--allowedTools`는 가변 인자라서 프롬프트를 **앞에** 둔다.

---

## 4. 상태 모델

`$.state`(세션 범위, 핫리로드에도 유지)에 세 값을 둔다. 계약은 `types/index.d.ts`에 있다.

| 키 | 타입 | 용도 |
| --- | --- | --- |
| `bars` | `TurnBar[]` | 그릴 바 목록. 기본 `MAX_BARS = 1`이라 현재 턴 하나 |
| `isOpen` | `boolean` | 바 표시/숨김 (Progress 버튼, `/turnbar`) |
| `tick` | `number` | 턴이나 에이전트가 도는 동안 1초마다 증가. 경과 시간을 다시 그리는 용도 |

`TurnBar`의 핵심 필드:
- `phase`: 지금까지 도달한 가장 먼 구간(`request`→`thinking`→`working`→`answering`). **뒤로 가지 않는다.**
- `activity`: 지금 하는 일. pill 라벨에 쓰고, 뒤로 갈 수 있다(작업 중에 다시 생각하면 `생각 중`).
- `frac`: 0..1 채움. `Math.max(이전, 새 값)`으로만 갱신한다.
- `calls`: 메인 루프의 도구 호출(`ToolRun`: 이름, 대상, 틱 위치 `frac`, 시작·끝 시각, 실패 여부). 최대 60개. 트랙의 틱과 타임라인의 행이 여기서 나온다.
- `spans`: 턴 시간을 무엇에 썼는지(`thinking`/`working`/`answering`/`waiting`)의 구간 목록. 최대 80개.
- `tokens`: `turn.complete`의 사용량(입력, 출력, 캐시 읽기·쓰기).

모듈 변수(핫리로드되면 사라져도 되는 값):
- `live`: 현재 턴의 카운터(`thinkChars`, `stepText`, `answerChars`, `tools`, `calls`, `spans`, `phase`, `activity`). 스트림 청크마다 여기만 갱신하고, 가끔씩 `bars`로 내보낸다(flush).
- `pendingMain`, `waitingMain`: 메인 루프의 진행 중인 tool_use_id와, 그중 권한 대기 중인 것.
- `agentHome`, `toolUses`, `waiting`, `foldUntil`: 에이전트 스트립용. plan-progress와 동일하다.

---

## 5. 이벤트 → 바 매핑

| 이벤트 | 조건 | 동작 |
| --- | --- | --- |
| `session.start` | | 1초 타이머(`isTicking`이 참이거나 에이전트가 돌거나 접힘 대기 중일 때 `tick++`), 슬래시 명령 4개 등록 |
| `turn.start` | 메인 루프만 발생 | `live` 초기화. 새 바 생성. `title`은 빈 프롬프트면 `계속`, 20자 이하 한 줄이면 그대로, 그 외에는 `""`로 두고 `nameTurn`을 기다리지 않고 실행한다(`$.model.complete({ model: "haiku", system: TITLE_SYSTEM, maxTokens: 40, effort: "low", timeoutMs: 10000 })`). 답이 오면 30자로 자르고 끝의 구두점을 지운다. 실패하면 첫 줄 30자를 쓴다. 아직 돌고 있는 백그라운드 에이전트는 새 바로 옮긴다. `isTicking = true` |
| `turn.step` (스트리밍 제너레이터) | `e.agentId` 없음, `e.turnId === live.turnId` | 청크를 **먼저 `yield`한 뒤** 관찰한다. 규칙은 6장 |
| `tool.call` | 서브에이전트(`e.agentId`) | 스트립의 `tool` 갱신, `toolUses`에 기록 |
| `tool.call` | 메인, `AskUserQuestion`/`ExitPlanMode` | 호출 전에 `needs_input`(note `질문`/`플랜 승인`) + decision 사운드, 반환 후 `running` |
| `tool.call` | 메인, 그 외 | 스트림이 만든 `ToolRun`을 `tool_use_id`로 찾아(없으면 추가) `target`(`targetOf`: 파일 이름, 명령, 패턴, 쿼리)과 `startedAt`을 채우고 flush. 끝나면 `endedAt`과 `isError`(`isError` 또는 `deny`)를 채우고 다시 flush. `pendingMain`에 넣었다 뺀다 |
| `tool.check` | 판정이 `ask` | 600ms 뒤에도 아직 대기 중이면 메인은 `needs_input`(`승인 대기`), 에이전트는 스트립을 amber로 바꾼다 |
| `agent.spawn` | | 부모 에이전트의 바, 없으면 현재 턴 바에 스트립 추가. 턴 밖이면 무시 |
| `turn.complete` | 서브에이전트 | 스트립을 `done`/`error`로. 실패하면 error 사운드 |
| `turn.complete` | 메인 | `reason`별 상태: `answer`→`done`(frac=1), `aborted`→`stopped`, `error`→`error`(`API 오류`), `refusal`→`error`(`refusal.explanation`). `live = null`, `isTicking = false`. done 사운드는 `durationMs ≥ 20000`일 때만 |
| `ui.render` `AbovePrompt` | 바가 있고, `hasSurvey`가 아니고, `isOpen` | 바 렌더링 (7장) |
| `ui.render` `SessionMode` | 항상 | 푸터에 Progress 버튼. 바가 없으면 dim, 누르면 토스트 |
| `command.run` | `/turnbar`, `/turnbar-sounds`, `/turnbar-clear`, `/turnbar-timeline` | 토글, 사운드 3종 재생, 전체 제거, 타임라인 패널 열기 |
| `ui.render` `Pane` `turn-timeline` | 패널이 열렸을 때 | 최신 턴의 타임라인 (7.2) |

---

## 6. 진행률 알고리즘

**구간** (`SEG`):

| phase | 구간 | 채움 공식 u (0..1, 상한 0.97) |
| --- | --- | --- |
| `request` | 0 | 0 (첫 청크 전) |
| `thinking` | 0 – 0.25 | `1 - exp(-thinkChars / 2400)` |
| `working` | 0.25 – 0.85 | `1 - 0.8^tools` |
| `answering` | 0.85 – 1.0 | `1 - exp(-answerChars / 1500)` |

`frac = a + (b - a) * min(0.97, u)`. 그리기에는 `max(bar.frac, frac)`를 쓴다. `done`이 되면 1이다.
구간 경계(0.25, 0.85)는 채움 계산에만 쓰고 그리지 않는다. 고정 비율이라 선으로 보여줘도 의미가 없었다.

**청크 규칙** (`turn.step`, 스텝마다 `stepText = 0`, `isStepTool = false`로 시작):
- `thinking`: `thinkChars += len`, `advance('thinking')`, `activity = 생각 중`. activity가 바뀐 순간 즉시 flush.
- `text`: `stepText += len`. **이 스텝에 도구 청크가 없고 `stepText ≥ 280`(`ANSWER_MIN_CHARS`)이면** 최종 답변으로 보고 `advance('answering')`, `answerChars = stepText`, `activity = 답변 작성`. 도구 전에 나오는 짧은 중간 멘트("확인해볼게요…")가 답변 구간으로 넘어가지 않게 하는 휴리스틱이다.
- `tool`: `isStepTool = true`, `tools++`, `advance('working')`, `activity = 작업 중`, `markSpan('working')`, `calls`에 `{ id: c.id, name, target: '', frac: fracOf, startedAt: null }`를 추가, 즉시 flush. thinking과 answering으로 바뀌는 순간에도 `markSpan`을 부른다(바뀔 때만 `$.clock.now()`).
- `stop`: 즉시 flush.
- 나머지 청크는 8개(`CLOCK_EVERY`)마다 시계를 보고, 마지막 flush 뒤 800ms(`FLUSH_MS`)가 지났을 때만 flush한다. 쓰기 한 번이 새 그림 한 장이라, 1초에 여러 번 그림을 바꾸면 픽셀 애니메이션이 매번 처음부터 다시 돌아 깜빡임으로 보인다.
- 채움 위치(`fx`)는 3px 픽셀 격자에 맞춰 반올림한다. 아주 작은 변화로는 그림이 바뀌지 않는다.
- 툴팁(`<title>`)은 바가 멈춘 뒤에만 넣는다. 진행 중인 호출의 초 단위 시간이 그림 안에 있으면 매초 그림이 바뀌기 때문이다.

`advance(to)`는 `ORDER`상 앞으로만 이동한다. 그래서 작업 뒤의 생각은 라벨만 바꾸고 채움은 작업 구간에 머문다.

**한계(의도된 것)**: 280자를 넘는 중간 설명 뒤에 도구를 부르면 바는 답변 구간에 머문 채 작업이 계속된다. 틱은 0.85 이후에 찍힌다. 뒤로 미끄러지는 것보다 덜 어색해서 이렇게 정했다.

---

## 7. UI 명세 (plan-progress와 동일하게)

**행 레이아웃** (`AbovePrompt`, 바마다 한 행):
```
[글리프] [제목 or dim …, truncate] ──flexGrow── [SVG 트랙 or 텍스트 바] [경과시간 5칸] [✕]
```
- `total = max(320, bodyColumns * 8)` px (데스크톱은 1열이 약 8 CSS px).
- 제목 칸은 고정 폭이다: `titleWidth = clamp(120, total*0.22, 220)`, `trackW = clamp(120, total - titleWidth - 140, 1400)`. 제목이 늦게 도착해도 트랙이 움직이지 않는다.
- 바가 여러 개면(`MAX_BARS > 1`) 사이에 1px 헤어라인 SVG(`#808080`, opacity .22)를 넣는다.
- 경과 시간: `59s`, `1:05` 형식이고 `padStart(4, U+2007 FIGURE SPACE)`라 9:59까지 폭이 고정된다(10분이 넘으면 한 칸 늘어난다). `endedAt`이 있으면 멈춘다.
- ✕: `Button plain dimColor`, 그 바를 `bars`에서 제거한다.

**상태 색과 글리프**

| state | 색 | 글리프 | pill 아이콘 |
| --- | --- | --- | --- |
| running | `#8B7CF6` | ● | 단계별: 화살표 / 점 세 개 / `</>` / 글줄 |
| needs_input | `#E09A1E` | ? | 물음표 path |
| error | `#E5484D` | ! | X path |
| stopped | `#8A8984` | ■ | 사각형 `M8 8h8v8H8z` |
| done | `#30A46C` | ✓ | 체크 path |

**SVG 트랙** (`trackSvg`, 높이 18px. 에이전트 스트립과 같은 높이라 한 묶음으로 읽힌다):
- 배경: 둥근 pill 클립(rx 9), `#808080` 16%.
- 채움 영역: 상태색 그라디언트(시작 opacity .05, 완료 시 .3 → 끝 .33).
- 픽셀: 3px 격자, 5행(세로 가운데 정렬), 2×2 사각형. 머리 쪽으로 갈수록 밀도가 높아지고(`0.22 + 0.78·u^1.5`) 회색 `#84828A`에서 상태색의 밝은 톤으로 5단계(b0–b4) 변한다. 해시 기반이라 결정적이다. `t0`–`t3` 네 그룹이 서로 다른 주기로 반짝인다(`prefers-reduced-motion`이면 정지).
- 마크: 도구 틱만 그린다. 1.5px 폭에 7px 높이이고, 지나간 틱은 밝은 흰톤(.6), 아직 안 지난 틱은 `#8A8984`(.45).
- 노브(pill): 상태색 rx 9. `[아이콘] 라벨 카운트` 순서이고 라벨은 500 11.5px 흰색(상태색 위라 테마와 무관), 카운트는 400에 opacity .75. 폭은 내용 길이에 맞춘다(`20 + 아이콘 16 + 라벨 + 카운트`, 최대 `max(80, W*0.55)`, 넘치면 `…`). **모든 상태에 아이콘이 붙는다**: running이면 단계별 아이콘(요청 → 화살표, 생각 → 점 세 개, 작업 → `</>`, 답변 → 글줄), 그 외에는 상태 아이콘(?, X, 사각형, 체크). 그래서 어떤 pill이든 `아이콘 라벨 n/3` 모양으로 같다. 위치는 채움 머리에 맞추고 양 끝에 clamp한다.
- 글라이드: 마지막 머리 위치(`lastHead`)에서 새 위치로 .45s 스플라인(`.2 .8 .2 1`). 채움 너비와 노브가 같이 움직인다.
- 좁을 때(`W < 360`): pill 대신 지름 18 원에 구간 번호(1 생각, 2 작업, 3 답변)를 넣고, 완료면 체크를 그린다.
- **한글 폭**: `textWidth`의 넓은 문자 범위에 `\u1100-\u11ff\uac00-\ud7af\uff00-\uffef`를 포함하고, 1em(11.5px)으로 잰다. 공백은 3.3px. 원본에는 이 범위가 빠져 있어서 한글 pill 폭이 틀렸다.

**pill 텍스트**
- 라벨: done `완료`, stopped `중단됨`, error `오류 · <note>`, needs_input `<note>`(질문/플랜 승인/승인 대기), running은 `activity`.
- 카운트: `n/3`(생각 1, 작업 2, 답변 3. 요청 직후는 1, 완료는 3). 서브에이전트가 있으면 ` · 에이전트 완료/전체`를 붙인다.

**에이전트 스트립** (`stripsSvg`, plan-progress 그대로): 트랙 아래 5px부터 18px 높이, 3px 간격. 이름과 시간 글자는 **테마를 따른다**: 기본은 `#26252B`(라이트), `@media (prefers-color-scheme:dark)`에서는 `#F0EEFC`. 데스크톱은 SVG를 이미지로 그리고, Chromium은 이미지 안의 미디어 쿼리에도 앱 테마를 반영한다(직접 확인함). 상태색 15% 바탕에 점(running이면 깜빡임), 이름(하위 에이전트는 `↳ `와 12px 들여쓰기), 현재 도구, 오른쪽에 경과 시간. 상태가 바뀌면 200ms 블러 모프와 색 흐름 애니메이션이 들어간다. 4개를 넘으면 완료된 것들은 `+N more agents · M done` 한 줄로 접힌다. 배치가 끝나고 5초 뒤 접히고, 실패한 스트립은 남는다.

**터미널 폴백** (`Svg` 요소가 없는 surface): `━`(상태색) / `─`(dim) 25칸 바 + ` 라벨 카운트`. 채움은 `frac*100`.

**접근성**: Svg `alt` = `제목: 라벨, 카운트, 경과시간; agents: …`.

**푸터 라벨**: `SessionMode`에 `Progress`를 버튼이 아닌 **글자(Text)** 로 항상 그리고, 아래 모드들의 라벨(`next(e)`)은 그대로 둔다. 바가 보이는 동안은 최신 턴의 상태색에 굵게, 숨겼거나 바가 없으면 dim이다. 데스크톱의 Button은 `plain`이어도 배경 칩을 그리고, 그 칩이 푸터 줄보다 높아서 글자가 잘렸다. 표시/숨김은 `/turnbar`로 한다.

**행 오른쪽 버튼**: 시계 뒤에 `≡`(타임라인 패널 열기)와 `✕`(바 닫기)를 둔다. 둘 다 `plain dimColor`. `trackW = clamp(120, total - titleWidth - 164, 1400)`.

### 7.1 툴팁 (Svg `isInteractive`)

트랙 Svg는 **바가 멈춘 뒤에만** `isInteractive`로 그린다(`isSettled`: 턴이 끝났고 돌고 있는 에이전트가 없음). 대화형 Svg는 스크립트 없는 샌드박스 프레임이라 `<title>` 툴팁과 hover가 동작하지만, 다시 그릴 때마다 프레임을 새로 불러온다. 진행 중에는 1초마다 다시 그리므로 대화형으로 그리면 바가 깜빡인다. 그래서 진행 중에는 이미지로 그리고, 툴팁은 끝난 턴에서만 쓴다.
- 틱마다 폭 8px짜리 투명 사각형을 겹치고 그 안에 `<title>`을 넣는다: `Edit · register.tsx · 0.8s`. 실행 중이면 `실행 중 3.2s`, 모델이 아직 호출을 쓰는 중이면 `준비 중`, 실패하면 `· 실패`가 붙고 틱이 빨간색이 된다.
- pill 그룹의 `<title>`: `6 도구 호출 · 토큰 입력 125k (캐시 94%) · 출력 3.1k`. 토큰은 턴이 끝난 뒤에만 나온다.
- 길이 표기: 10초 미만은 `0.8s`처럼 소수 한 자리, 그 이상은 `m:ss`.

### 7.2 타임라인 패널

`≡` 버튼이나 `/turnbar-timeline`으로 `$.ui.open({ id: 'turn-timeline', title: '턴 타임라인' })`을 연다. 사람이 연 패널이라 어떤 폭에서든 자리를 잡는다. 패널은 `bars`의 마지막 바를 그리고, 턴이 진행되는 동안 계속 갱신된다.
패널은 그림 대신 **글자 행**으로 그리고, 그림은 단계 비율 막대 하나만 쓴다.
```
● 깜빡임 원인 확인                     생각 중  37s
[■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■]     ← 단계 비율 막대 (높이 10, 둥근 끝)
● 생각 18s   ● 작업 14s   ● 대기 0.4s   ● 답변 5s   ← 범례 겸 합계

도구 호출 2
+0:21  Bash  깜빡임 관련 코드 찾기                1.0s
+0:28  Bash  플러시 루프 읽기                     0.6s
↳ 에이전트  Check migrations                    52s
토큰 입력 125k (캐시 94%) · 출력 3.1k
```
- 머리 줄: 상태 글리프, 제목(굵게, truncate), 오른쪽에 상태 라벨(상태색)과 경과 시간.
- 단계 막대(`phaseBarSvg`): `spans`를 시간 순서대로 칠한다. 색은 생각 `#B4A9F9`, 작업 `#8B7CF6`, 대기 `#E09A1E`, 답변 `#30A46C`이고, 칸마다 `<title>`이 있다. 터미널에서는 같은 색의 `━` 40칸으로 그린다.
- 범례: 실제로 시간을 쓴 종류만 `● 생각 18s` 형태로 보여준다(`spanTotals`).
- 호출 행: `+시작 시점`(턴 시작 기준, 5칸 고정), 도구 이름(진행색, 실패는 빨강), 대상(dim), 오른쪽에 길이. 대상과 머리 줄의 제목은 `flexGrow 1 · flexShrink 1` Box 안의 `wrap="truncate"` Text라서, 길면 앱이 실제 폭으로 잘라 `…`을 붙인다. 시작 시점, 도구 이름, 길이는 밀리지 않는다. 실행 중이면 `실행 중 3.2s`, 실패면 `실패 0.4s`. **턴의 20% 이상이자 2초 이상 걸린 호출은 대상과 길이를 굵게** 표시해서 시간이 어디서 갔는지 바로 보이게 한다.
- 에이전트 행: `↳ 에이전트  제목  길이`, 상태색.
- 대상(`targetOf`)은 파일이면 이름만, 그 외에는 **호출의 `description`을 명령보다 먼저** 쓴다(Bash, Agent). 날것의 명령보다 읽기 쉽다.
- 토큰 줄은 턴이 끝나 사용량이 있을 때만 보인다.


---

## 8. 사운드

`$.audio.play({ asset: 'sounds/<name>.wav' })`를 먼저 시도하고, 실패하면 PowerShell `Media.SoundPlayer`를 쓴다(Windows).

| 사운드 | 언제 |
| --- | --- |
| decision | `needs_input`에 처음 들어갈 때 (질문, 플랜 승인, 600ms 넘게 걸린 권한 대기) |
| error | 메인 턴이 error로 끝날 때, 서브에이전트가 실패할 때 |
| done | 메인 턴이 `answer`로 끝나고 `durationMs ≥ 20000`일 때 |

---

## 9. 엣지 케이스

- **연속 턴/백그라운드 알림**: `turn.start.text`가 `""`인 턴(continuation, 작업 알림)도 바를 만들고 제목은 `계속`이다.
- **백그라운드 에이전트가 턴보다 오래 돌 때**: 새 턴이 시작되면 아직 running/waiting인 에이전트를 새 바로 옮기고 `agentHome`도 바꾼다.
- **핫리로드 중의 턴**: `live`가 사라지므로 그 턴의 바는 다음 턴이 올 때까지 마지막 상태로 남는다. 의도된 동작이다.
- **동시 쓰기**: 모든 쓰기는 `update($, atom, fn)` 안에서 최신 목록으로 계산한다(ifVersion 재시도). `update` fn 안의 부수효과(`agentHome.set`)는 재시도해도 결과가 같아야 한다.
- **스트림 지연**: `turn.step`에서는 반드시 `yield c`를 먼저 하고 그다음에 `await flush`. 화면 스트리밍이 막히지 않는다. 제너레이터가 값을 반환하지 않으면 `next(e)`의 결과가 그대로 쓰인다.
- **렌더 훅에서 쓰기 금지**: `ui.render` 안에서는 `read`만 한다. 쓰기는 `onPress` 클로저나 다른 이벤트에서 한다.
- **설문 우선**: `e.props.hasSurvey`면 `next(e)`로 양보한다.

---

## 10. 수동 확인 시나리오

1. 도구를 몇 번 쓰는 요청: 틱이 찍히고, 끝난 뒤 틱에 마우스를 올리면 툴팁이 나온다. `≡`을 누르면 타임라인 패널이 열린다. 세 줄 높이가 같고, 라이트와 다크 모두 글자가 읽혀야 한다.
2. "안녕"처럼 짧은 질문: 생각 → 답변으로 바로 점프하고(작업 구간 건너뜀) `완료`, 사운드 없음.
3. 파일 몇 개를 고치는 요청: 0.25 이후에 도구 틱이 늘고, pill이 `작업 중 2/3`으로 바뀌며, 끝나면 `완료 3/3`. 긴 프롬프트는 1초 안에 `…`이 요약 제목으로 바뀐다. 20초가 넘으면 done 사운드.
4. 권한이 필요한 Bash: 600ms 뒤 amber `승인 대기` + decision 사운드. 승인하면 보라색으로 돌아온다.
5. Esc로 중단: 회색 `중단됨`, 채움은 그 자리에서 멈춘다.
6. Agent 도구 2개 병렬: 스트립 2개, 완료 후 5초 뒤 접힘.
7. 창을 좁히기(`W < 360`): 원형 노브에 구간 번호.
8. 터미널(`claude --plugin-dir .`): 텍스트 바 폴백.
9. Progress 버튼과 `/turnbar`: 숨김/표시 토글.

---

## 11. 라이선스

부록 A의 그리기 코드(`trackSvg`, `stripsSvg`, 레이아웃, 사운드 재생)는 MIT 라이선스인 `plan-progress`(Copyright (c) 2026 Kirill Serditov)에서 가져와 고친 것이다. 새 저장소의 `LICENSE`에 원저작권 표기를 남긴다.
```
MIT License

Copyright (c) 2026 Dan
Portions derived from plan-progress, Copyright (c) 2026 Kirill Serditov

(이하 표준 MIT 본문)
```
원본에서 복사한 wav를 쓴다면 README에도 출처를 한 줄 적는다.

---

## 12. 다음 단계 아이디어 (선택)

- `userConfig`로 `doneSoundMinMs`, `answerMinChars`, `maxBars`를 노출한다(설정 메뉴에 행이 생기고, 바꾸면 모듈이 재로드된다).
- 세션 누적 토큰/비용을 작은 그래프(`Raster`)로 그리기 (`tokens`는 이미 턴마다 저장 중).
- 최근 N턴 히스토리: `MAX_BARS`를 키우고 완료된 바를 dim 처리.

---

## 부록 A. 전체 소스 (검증 완료: Claude Code 2.1.286)

### A.1 `.claude-plugin/plugin.json`

```json
{
  "name": "turn-progress",
  "version": "0.1.0",
  "description": "Live status bar above the prompt for each turn: request, thinking, working, answer",
  "author": { "name": "Dan" },
  "license": "MIT",
  "types": "./types/index.d.ts"
}
```

### A.2 `hooks/hooks.json`

```json
{ "modules": ["./register.tsx"] }
```

### A.3 `types/index.d.ts`

```ts
export type TurnState = 'running' | 'needs_input' | 'error' | 'stopped' | 'done'
// the furthest part of the turn reached; drives the fill, never goes back within a turn
export type Phase = 'request' | 'thinking' | 'working' | 'answering'
// one subagent shown as a state strip under the bar; depth 1 sits under its parent agent
export type AgentRun = {
  id: string
  title: string
  state: 'running' | 'waiting' | 'done' | 'error'
  tool: string
  startedAt: number
  endedAt: number | null
  depth: number
}
// one tool call of the main loop: a tick on the track, a row in the timeline
export type ToolRun = {
  id: string // tool_use_id
  name: string
  target: string // the file, command or query it works on; '' until the call runs
  frac: number // where on the track its tick sits
  startedAt: number | null // when it began to run; null while the model still writes it
  endedAt: number | null
  isError: boolean
}
// a stretch of the turn spent on one thing, for the timeline's top lane
export type SpanKind = 'thinking' | 'working' | 'answering' | 'waiting'
export type Span = { kind: SpanKind; start: number; end: number | null }
// what the turn cost, as turn.complete reports it
export type TurnTokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type TurnBar = {
  id: string // the turn's turnId
  title: string // a short name for the request; '' while it is being named
  phase: Phase
  activity: string // what happens right now: the pill's label
  state: TurnState
  frac: number // 0..1, the fill
  calls: ToolRun[]
  spans: Span[]
  note: string | null
  startedAt: number
  endedAt: number | null
  tokens: TurnTokens | null
  agents?: AgentRun[]
  // when the current batch of agents all finished; their strips fold a few seconds later
  agentsDoneAt?: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'turn-progress': {
      bars: TurnBar[]
      isOpen: boolean
      // bumped every second while a turn or an agent runs, so elapsed times redraw
      tick: number
    }
  }
}
```

### A.4 `hooks/register.tsx`

```tsx
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Phase, Span, SpanKind, ToolRun, TurnBar, TurnState } from '../types'

const bars = atom({ plugin: 'turn-progress', key: 'bars' } as const, [])
const isOpen = atom({ plugin: 'turn-progress', key: 'isOpen' } as const, true)
const tick = atom({ plugin: 'turn-progress', key: 'tick' } as const, 0)

const MAX_BARS = 1 // the current turn; a new turn replaces the finished one
// a space as wide as a digit, so " 9s" and "1:05" take the same room (4 cells: up to 9:59 without a shift)
const FIGURE_SPACE = String.fromCharCode(0x2007)
const TRACK_H = 18 // the same height as an agent strip, so the rows read as one stack
const PX_ROWS = 5 // pixel rows inside the track: 3px pitch, centred
const NARROW = 360
const STRIP_H = TRACK_H
const STRIP_GAP = 3
const MAX_STRIPS = 4 // past this, the finished ones fold into one "+N more" strip
const FOLD_MS = 5000 // finished strips stay this long, failed ones stay until the bar goes
const ASK_DELAY_MS = 600 // a permission ask still open after this waits on the person
const DONE_SOUND_MIN_MS = 20_000 // a short turn finishes quietly
const ANSWER_MIN_CHARS = 280 // this much text in a step with no tool call reads as the final answer
// while text or thinking streams, the bar is written at most this often: every write is a new picture,
// and a picture swapped many times a second restarts its animations and reads as flicker
const FLUSH_MS = 800
const CLOCK_EVERY = 8 // streamed chunks between looks at the clock
const MAX_CALLS = 60 // tool calls kept per turn: ticks on the track, rows in the timeline
const MAX_SPANS = 80
const PANE = 'turn-timeline'

const STATE_COLOR: Record<TurnState, string> = { running: '#8B7CF6', needs_input: '#E09A1E', error: '#E5484D', stopped: '#8A8984', done: '#30A46C' }
const STATE_GLYPH: Record<TurnState, string> = { running: '●', needs_input: '?', error: '!', stopped: '■', done: '✓' }

const LABEL = {
  request: '요청 받음',
  thinking: '생각 중',
  working: '작업 중',
  answering: '답변 작성',
  needs_input: '입력 대기',
  question: '질문',
  plan: '플랜 승인',
  approval: '승인 대기',
  error: '오류',
  apiError: 'API 오류',
  refused: '거절됨',
  stopped: '중단됨',
  done: '완료',
  untitled: '계속',
  agents: '에이전트',
  button: 'Progress',
  timeline: '턴 타임라인',
  timelineButton: '≡',
  noTurn: '아직 기록된 턴이 없습니다.',
  lane: '단계',
  calls: '도구 호출',
  running: '실행 중',
  writing: '준비 중',
  failed: '실패',
  tokens: '토큰',
  input: '입력',
  output: '출력',
  cache: '캐시',
}

// the bar's three parts; request is the moment before the first chunk
const SEG: Record<Phase, readonly [number, number]> = { request: [0, 0], thinking: [0, 0.25], working: [0.25, 0.85], answering: [0.85, 1] }
const ORDER: Phase[] = ['request', 'thinking', 'working', 'answering']

// ---------- the live turn: counters the stream moves, written to the bar now and then ----------

type Live = {
  turnId: string
  phase: Phase
  activity: string
  thinkChars: number
  stepText: number
  isStepTool: boolean
  answerChars: number
  tools: number
  calls: ToolRun[]
  spans: Span[]
}

function fracOf(l: Live): number {
  const [a, b] = SEG[l.phase]
  const u =
    l.phase === 'thinking' ? 1 - Math.exp(-l.thinkChars / 2400)
    : l.phase === 'working' ? 1 - Math.pow(0.8, l.tools)
    : l.phase === 'answering' ? 1 - Math.exp(-l.answerChars / 1500)
    : 0

  return a + (b - a) * Math.min(0.97, u)
}

// the fill only moves forward: thinking after a tool call changes the label, not the phase
const advance = (l: Live, to: Phase) => {
  if (ORDER.indexOf(to) > ORDER.indexOf(l.phase)) l.phase = to
}

// a new stretch of the turn starts; the open one ends where it begins
function markSpan(l: Live, kind: SpanKind, now: number) {
  const last = l.spans[l.spans.length - 1]
  if (last && last.end === null && last.kind === kind) return
  if (last && last.end === null) last.end = now
  l.spans.push({ kind, start: now, end: null })
  if (l.spans.length > MAX_SPANS) l.spans.shift()
}

// what a call works on, in a few words: a file's name, a command, a pattern or query
function targetOf(input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const path = s('file_path') || s('notebook_path') || s('path')
  if (path) return path.split('/').filter(Boolean).pop() ?? path
  // a call's own description (Bash, Agent) reads better than the raw command
  const text = s('description') || s('command') || s('pattern') || s('query') || s('url') || s('skill') || s('prompt')
  return text.replace(/\s+/g, ' ').trim().slice(0, 48)
}

const firstLine = (text: string) => {
  const line = text.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? ''
  return line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`#>"']/g, '').replace(/\s+/g, ' ').trim()
}

const SHORT_TITLE = 20 // a one-line prompt this short is its own title; a longer one is named
const TITLE_MODEL = 'haiku'
const TITLE_SYSTEM =
  'You name a task for a status bar. Reply with only a title of 2 to 5 words that says what the request asks for, in the language of the request. No quotes, no trailing punctuation, no explanation.'

// asks a small model for a 2-5 word title; the prompt's first line stands in when it has none
async function nameTurn($: EngineInterface, turnId: string, text: string) {
  const fallback = [...firstLine(text)].slice(0, 30).join('') || LABEL.untitled
  const r = await $.model.complete({ model: TITLE_MODEL, system: TITLE_SYSTEM, prompt: text.slice(0, 2000), maxTokens: 40, effort: 'low', timeoutMs: 10_000 })
  const named = r.isAnswered ? [...firstLine(r.text).replace(/[.。!?…]+$/, '')].slice(0, 30).join('') : ''
  await update($, bars, list => list.map(b => (b.id === turnId && !b.title ? { ...b, title: named || fallback } : b)))
}

// ---------- drawing ----------

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const mix = (a: number[], b: number[], m: number) => a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * m))
const rgb = (c: number[]) => `rgb(${c.join(',')})`
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const hash = (a: number, b: number, k: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453
  return x - Math.floor(x)
}
// Hangul, CJK and full-width forms are one em wide (the pill and strip text are 11.5px)
const WIDE = /[ᄀ-ᇿ　-鿿가-힯＀-￯]/
// an estimate of the drawn width, for sizing the pill and truncating
const textWidth = (s: string, px = 6.7) => [...s].reduce((w, ch) => w + (WIDE.test(ch) ? 11.5 : ch === ' ' ? 3.3 : /[ilI.,:;'|!]/.test(ch) ? 3.4 : /[mwMWШЩЖМ]/.test(ch) ? 9.5 : px), 0)

const ICON_PATH: Partial<Record<TurnState, string>> = {
  needs_input: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
  error: 'M18 6 6 18M6 6l12 12',
  stopped: 'M8 8h8v8H8z',
  done: 'M20 6 9 17l-5-5',
}
// while running, the icon names the part of the turn, so every pill reads icon + label
const PHASE_ICON: Record<Phase, string> = {
  request: 'M5 12h14M13 6l6 6-6 6',
  thinking: 'M5.5 12h1M11.5 12h1M17.5 12h1',
  working: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  answering: 'M4 6h16M4 12h16M4 18h10',
}

const clockText = (ms: number) => {
  const sec = Math.max(0, Math.round(ms / 1000))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

// a call's length: tenths under ten seconds, then the clock
const durationText = (ms: number) => (ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : clockText(ms))

const kilo = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`)

function callText(c: ToolRun, now: number): string {
  const time = c.startedAt === null ? LABEL.writing : c.endedAt === null ? `${LABEL.running} ${durationText(now - c.startedAt)}` : durationText(c.endedAt - c.startedAt)
  return [c.name, c.target, time, c.isError ? LABEL.failed : ''].filter(Boolean).join(' · ')
}

function tokensText(b: TurnBar): string {
  const t = b.tokens
  if (!t) return ''
  const input = t.input + t.cacheRead + t.cacheWrite
  const cached = input > 0 ? Math.round((t.cacheRead / input) * 100) : 0
  return `${LABEL.tokens} ${LABEL.input} ${kilo(input)} (${LABEL.cache} ${cached}%) · ${LABEL.output} ${kilo(t.output)}`
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function pillName(b: TurnBar): string {
  if (b.state === 'done') return LABEL.done
  if (b.state === 'stopped') return LABEL.stopped
  if (b.state === 'error') return b.note ? `${LABEL.error} · ${b.note}` : LABEL.error
  if (b.state === 'needs_input') return b.note ?? LABEL.needs_input

  return b.activity
}

// the part of the turn as n/3 (thinking, working, answer), then the subagents while there are some;
// tool calls show as ticks on the track, not as text
function pillCount(b: TurnBar): string {
  const parts = ORDER.length - 1
  const part = b.state === 'done' ? parts : Math.max(1, ORDER.indexOf(b.phase))
  const agents = b.agents ?? []
  const agentText = agents.length > 0 ? ` · ${LABEL.agents} ${agents.filter(a => a.state === 'done').length}/${agents.length}` : ''

  return `${part}/${parts}${agentText}`
}

// last drawn head position per bar, so a redraw glides from where the bar was
const lastHead = new Map<string, number>()

function trackSvg(b: TurnBar, W: number, now: number): string {
  const H = TRACK_H
  const done = b.state === 'done'
  const frac = done ? 1 : Math.min(1, Math.max(0, b.frac))
  // snapped to the 3px pixel grid, so a tiny change of the fill draws the same picture
  const fx = Math.round((frac * W) / 3) * 3
  const from = lastHead.get(b.id) ?? fx
  lastHead.set(b.id, fx)

  const acc = hex(STATE_COLOR[b.state])
  const light = mix(acc, [255, 255, 255], 0.32)
  const grey = [132, 130, 138]
  const ease = 'calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .2 1"'
  const glide = Math.abs(from - fx) > 0.5

  // pixels: 3px grid, 7 rows, denser and closer to the state colour towards the head
  const buckets = [0, 1, 2, 3, 4].map(k => {
    const m = k / 4
    const dense = done ? 0.8 : 0.22 + 0.78 * Math.pow(m, 1.5)
    return { color: rgb(done ? light : mix(grey, light, m)), opacity: (0.35 + 0.65 * dense).toFixed(2) }
  })
  let px = ''
  for (let col = 0; col * 3 < fx; col++) {
    const x = col * 3
    const u = Math.min(1, (x + 1.5) / fx)
    const dense = done ? 0.8 : 0.22 + 0.78 * Math.pow(u, 1.5)
    const bucket = done ? 4 : Math.min(4, Math.floor(Math.min(1, Math.pow(u, 0.9) * 1.1) * 4.99))
    for (let r = 0; r < PX_ROWS; r++) {
      if (hash(col, r, 1) > dense + 0.1) continue
      px += `<rect x="${x}" y="${(H - (PX_ROWS * 3 - 1)) / 2 + r * 3}" class="b${bucket} t${Math.floor(hash(col, r, 2) * 4)}"/>`
    }
  }

  // a short tick per tool call, bright once passed; a wider clear strip over each carries its tooltip
  const marks = b.calls
    .map(c => {
      const x = c.frac * W
      const passed = x < fx - 1
      const fill = c.isError ? STATE_COLOR.error : passed ? rgb(mix(light, [255, 255, 255], 0.45)) : '#8A8984'
      return `<rect x="${(x - 0.75).toFixed(1)}" y="${(H - 7) / 2}" width="1.5" height="7" rx=".75" fill="${fill}" opacity="${c.isError ? 0.9 : passed ? 0.6 : 0.45}"/>`
    })
    .join('')
  // tooltips only once the bar is settled: only then is it drawn interactive, and a running call's time
  // in them would change the picture every second
  const isTipped = isSettled(b)
  const hits = isTipped ? b.calls.map(c => `<rect x="${(c.frac * W - 4).toFixed(1)}" y="0" width="8" height="${H}" fill="transparent"><title>${esc(callText(c, now))}</title></rect>`).join('') : ''
  const pillTip = isTipped ? `<title>${esc([`${b.calls.length} ${LABEL.calls}`, tokensText(b)].filter(Boolean).join(' · '))}</title>` : ''

  // knob: a pill with the activity and counts, or a round dot with the part number when narrow
  const color = STATE_COLOR[b.state]
  const icon = b.state === 'running' ? PHASE_ICON[b.phase] : ICON_PATH[b.state]
  let knob = ''
  let kw = H
  if (W < NARROW) {
    const number = Math.max(1, ORDER.indexOf(b.phase))
    knob = `<circle cx="0" cy="${H / 2}" r="${H / 2}" fill="${color}"/>${
      done
        ? `<path d="${ICON_PATH.done}" transform="translate(-6 ${(H - 12) / 2}) scale(.5)" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<text x="0" y="${H / 2 + 4}" text-anchor="middle" class="kt">${number}</text>`
    }`
  } else {
    const name = pillName(b)
    const count = pillCount(b)
    const iconW = icon ? 16 : 0
    const countW = count ? 6 + textWidth(count, 6.5) : 0
    const maxW = Math.max(80, W * 0.55)
    let shown = name
    while (shown.length > 3 && 20 + iconW + textWidth(shown) + countW > maxW) shown = shown.slice(0, -1)
    if (shown !== name) shown = shown.trimEnd() + '…'
    kw = Math.round(20 + iconW + textWidth(shown) + countW)
    const left = -kw / 2 + 10
    knob = `<rect x="${-kw / 2}" y="0" width="${kw}" height="${H}" rx="${H / 2}" fill="${color}"/>`
    if (icon) knob += `<path d="${icon}" transform="translate(${left} ${(H - 12) / 2}) scale(.5)" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`
    knob += `<text x="${left + iconW}" y="${H / 2 + 4}" class="kt">${esc(shown)}${count ? `<tspan class="kc" dx="6">${esc(count)}</tspan>` : ''}</text>`
  }
  const clampX = (x: number) => Math.max(kw / 2, Math.min(W - kw / 2, x))
  const kx = clampX(fx)
  const kFrom = clampX(from)

  const style = `<style>
.b0{fill:${buckets[0]?.color};fill-opacity:${buckets[0]?.opacity}}.b1{fill:${buckets[1]?.color};fill-opacity:${buckets[1]?.opacity}}
.b2{fill:${buckets[2]?.color};fill-opacity:${buckets[2]?.opacity}}.b3{fill:${buckets[3]?.color};fill-opacity:${buckets[3]?.opacity}}
.b4{fill:${buckets[4]?.color};fill-opacity:${buckets[4]?.opacity}}
rect[class]{width:2px;height:2px}
.t0,.t1,.t2,.t3{animation:tw ${done ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${done ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${done ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${done ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${done ? 0.8 : 0.45}}}
.kt{font:500 11.5px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;fill:#fff}
.kc{font-weight:400;fill-opacity:.75}
@media (prefers-reduced-motion:reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>`
  const glideFill = glide ? `<animate attributeName="width" from="${from.toFixed(1)}" to="${fx.toFixed(1)}" dur=".45s" ${ease} fill="freeze"/>` : ''
  const glideKnob = glide ? `<animateTransform attributeName="transform" type="translate" from="${kFrom.toFixed(1)} 0" to="${kx.toFixed(1)} 0" dur=".45s" ${ease} fill="freeze"/>` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${style}
<defs><clipPath id="pill"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath><clipPath id="fill"><rect width="${fx.toFixed(1)}" height="${H}">${glideFill}</rect></clipPath>
<linearGradient id="base" x1="0" x2="${fx.toFixed(1)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${rgb(acc)}" stop-opacity="${done ? 0.3 : 0.05}"/><stop offset="1" stop-color="${rgb(acc)}" stop-opacity=".33"/></linearGradient></defs>
<g clip-path="url(#pill)"><rect width="${W}" height="${H}" fill="#808080" fill-opacity=".16"/>
<g clip-path="url(#fill)"><rect width="${fx.toFixed(1)}" height="${H}" fill="url(#base)"/>${px}</g>${marks}${hits}</g>
<g transform="translate(${kx.toFixed(1)} 0)">${pillTip}${glideKnob}${knob}</g></svg>`
}

const AGENT_COLOR: Record<AgentRun['state'], string> = {
  running: STATE_COLOR.running,
  waiting: STATE_COLOR.needs_input,
  done: STATE_COLOR.done,
  error: STATE_COLOR.error,
}

// which strips show: all of a small batch; in a big one the unfinished first, the rest folded into one line
function visibleAgents(b: TurnBar, now: number): { shown: AgentRun[]; hidden: AgentRun[] } | null {
  const list = b.agents ?? []
  if (list.length === 0) return null
  const hasError = list.some(a => a.state === 'error')
  if (b.agentsDoneAt && now - b.agentsDoneAt > FOLD_MS && !hasError) return null
  if (list.length <= MAX_STRIPS) return { shown: list, hidden: [] }
  const keep = new Set(list.filter(a => a.state !== 'done').slice(0, MAX_STRIPS - 1).map(a => a.id))
  for (const a of [...list].reverse()) {
    if (keep.size >= MAX_STRIPS - 1) break
    keep.add(a.id)
  }
  return { shown: list.filter(a => keep.has(a.id)), hidden: list.filter(a => !keep.has(a.id)) }
}

// what each strip showed last time it was drawn, so a change morphs from the old status instead of jumping
const lastStrip = new Map<string, { tool: string; color: string }>()
const MORPH = '.2s'

const stripsHeight = (n: number) => n * STRIP_H + (n - 1) * STRIP_GAP

// one tinted strip per agent: state colour, name, what it does now and for how long; not a progress bar
function stripsSvg(v: { shown: AgentRun[]; hidden: AgentRun[] }, W: number, now: number): string {
  const isNarrow = W < NARROW
  const rows: string[] = []
  v.shown.forEach((a, i) => {
    const c = AGENT_COLOR[a.state]
    const y = i * (STRIP_H + STRIP_GAP)
    const indent = a.depth > 0 ? 12 : 0
    let px = ''
    if (a.state === 'running') {
      for (let col = 0; col * 3 < W; col++) {
        for (let r = 0; r < 4; r++) {
          if (hash(col + i * 41, r, 5) > 0.2) continue
          px += `<rect x="${col * 3}" y="${y + 3 + r * 3.6}" class="t${Math.floor(hash(col, r, 6) * 4)}" fill="${c}" fill-opacity=".32"/>`
        }
      }
    }
    const nameRoom = isNarrow ? W - 30 - indent : W * 0.5
    const full = (a.depth > 0 ? '↳ ' : '') + a.title
    let name = full
    while (name.length > 4 && textWidth(name, 6.2) > nameRoom) name = name.slice(0, -1)
    if (name !== full) name = name.trimEnd() + '…'
    const nameX = 19 + indent
    const toolX = nameX + textWidth(name, 6.2) + 8
    const time = clockText((a.endedAt ?? now) - a.startedAt)
    // a status change: the old word blurs out while the new one blurs in, and the tint flows to the new colour
    const was = lastStrip.get(a.id)
    lastStrip.set(a.id, { tool: a.tool, color: c })
    const isToolChanged = was !== undefined && was.tool !== a.tool
    const flow = (attr: string) => (was && was.color !== c ? `<animate attributeName="${attr}" from="${was.color}" to="${c}" dur="${MORPH}" fill="freeze"/>` : '')
    const tool = isNarrow
      ? ''
      : (isToolChanged ? `<text x="${toolX}" y="${y + 12.5}" class="sn mo" style="fill:${was.color}">${esc(was.tool)}</text>` : '') +
        `<text x="${toolX}" y="${y + 12.5}" class="sn${isToolChanged ? ' mi' : ''}" style="fill:${c}">${esc(a.tool)}</text>` +
        `<text x="${W - 9}" y="${y + 12.5}" text-anchor="end" class="sn st">${time}</text>`
    rows.push(
      `<rect x="0" y="${y}" width="${W}" height="${STRIP_H}" rx="${STRIP_H / 2}" fill="${c}" fill-opacity=".15">${flow('fill')}</rect>${px}` +
        `<circle cx="${10 + indent}" cy="${y + STRIP_H / 2}" r="3" fill="${c}"${a.state === 'running' ? ' class="sd"' : ''}>${flow('fill')}</circle>` +
        `<text x="${nameX}" y="${y + 12.5}" class="sn">${esc(name)}</text>` +
        tool,
    )
  })
  if (v.hidden.length > 0) {
    const y = v.shown.length * (STRIP_H + STRIP_GAP)
    const doneCount = v.hidden.filter(a => a.state === 'done').length
    rows.push(
      `<rect x="0" y="${y}" width="${W}" height="${STRIP_H}" rx="${STRIP_H / 2}" fill="#808080" fill-opacity=".14"/>` +
        `<text x="10" y="${y + 12.5}" class="sn st">+${plural(v.hidden.length, 'more agent')} · ${doneCount} done</text>`,
    )
  }
  return `<style>.sn{font:400 11.5px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;fill:#26252B}.st{fill-opacity:.6}
@media (prefers-color-scheme:dark){.sn{fill:#F0EEFC}.st{fill-opacity:.65}}
.sd{animation:sp 1.1s ease-in-out infinite}@keyframes sp{50%{opacity:.3}}
.mi{animation:mi ${MORPH} ease-out both}@keyframes mi{from{opacity:0;filter:blur(3px)}}
.mo{animation:mo ${MORPH} ease-in both}@keyframes mo{to{opacity:0;filter:blur(3px)}}
@media (prefers-reduced-motion:reduce){.sd,.mi,.mo{animation:none}.mo{opacity:0}}</style>${rows.join('')}`
}

const SPAN_COLOR: Record<SpanKind, string> = { thinking: '#B4A9F9', working: STATE_COLOR.running, waiting: STATE_COLOR.needs_input, answering: STATE_COLOR.done }
const SPAN_LABEL: Record<SpanKind, string> = { thinking: LABEL.thinking, working: LABEL.working, waiting: LABEL.needs_input, answering: LABEL.answering }
const SPAN_SHORT: Record<SpanKind, string> = { thinking: '생각', working: '작업', waiting: '대기', answering: '답변' }
const SPAN_KINDS: SpanKind[] = ['thinking', 'working', 'waiting', 'answering']
const PHASE_BAR_H = 10

// how long the turn spent on each kind of stretch
function spanTotals(b: TurnBar, now: number): Record<SpanKind, number> {
  const sum: Record<SpanKind, number> = { thinking: 0, working: 0, waiting: 0, answering: 0 }
  for (const sp of b.spans) sum[sp.kind] += Math.max(0, (sp.end ?? now) - sp.start)
  return sum
}

// the turn as one bar: each stretch in its colour, in order, across the whole width; a gap is time not yet in a stretch
function phaseBarSvg(b: TurnBar, W: number, now: number): string {
  const t0 = b.startedAt
  const total = Math.max(1000, (b.endedAt ?? now) - t0)
  const x = (t: number) => ((Math.min(Math.max(t, t0), t0 + total) - t0) / total) * W
  const segs = b.spans
    .map(sp => {
      const x1 = x(sp.start)
      const w = Math.max(1.5, x(sp.end ?? now) - x1)
      return `<rect x="${x1.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${PHASE_BAR_H}" fill="${SPAN_COLOR[sp.kind]}"><title>${esc(`${SPAN_LABEL[sp.kind]} · ${durationText((sp.end ?? now) - sp.start)}`)}</title></rect>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${PHASE_BAR_H}" viewBox="0 0 ${W} ${PHASE_BAR_H}"><defs><clipPath id="r"><rect width="${W}" height="${PHASE_BAR_H}" rx="${PHASE_BAR_H / 2}"/></clipPath></defs><g clip-path="url(#r)"><rect width="${W}" height="${PHASE_BAR_H}" fill="#808080" fill-opacity=".14"/>${segs}</g></svg>`
}

// ---------- engine glue ----------

// the engine's player first (afplay on macOS); PowerShell where it cannot play
function play($: EngineInterface, name: 'decision' | 'error' | 'done') {
  const file = `${$.plugin.root}/sounds/${name}.wav`.replace(/\//g, '\\')
  void $.audio.play({ asset: `sounds/${name}.wav` }).catch(() =>
    $.process
      .run(['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `(New-Object Media.SoundPlayer '${file}').PlaySync()`], { timeoutMs: 5000 })
      .catch(() => undefined),
  )
}

const isLive = (b: TurnBar) => b.state === 'running' || b.state === 'needs_input'
// an interactive Svg (tooltips) is a frame that reloads on every redraw, so a bar that still redraws every
// second would flicker; it turns interactive only once nothing on it moves any more
const isSettled = (b: TurnBar) => !isLive(b) && !(b.agents ?? []).some(a => a.state === 'running' || a.state === 'waiting')

// adds or replaces one bar by id; keeps at most MAX_BARS, dropping finished ones first
// computed inside update() from the latest list, so concurrent writers do not drop each other
function placeBar(list: readonly TurnBar[], next: TurnBar): TurnBar[] {
  const prev = list.find(b => b.id === next.id)
  const rest = prev ? list.map(b => (b.id === next.id ? next : b)) : [...list, next]
  while (rest.length > MAX_BARS) {
    const doneAt = rest.findIndex(b => !isLive(b))
    rest.splice(doneAt >= 0 ? doneAt : 0, 1)
  }
  return rest
}

// Module state: a reload forgets the live turn and running agents; their bar then stays until the next turn.
let live: Live | null = null
let isTicking = false
const pendingMain = new Set<string>() // main-loop tool_use_ids in flight, to find a permission ask
const waitingMain = new Set<string>() // of those, the ones held on the person
const agentHome = new Map<string, string>() // agentId -> bar id
const toolUses = new Map<string, string>() // tool_use_id -> agentId, to find who waits on a permission
const waiting = new Set<string>()
let foldUntil = 0 // keep ticking until finished strips have folded

// writes the live counters into the bar; the fill only grows
async function flush($: EngineInterface) {
  const l = live
  if (!l) return
  const frac = fracOf(l)
  await update($, bars, list =>
    list.map(b =>
      b.id !== l.turnId || !isLive(b)
        ? b
        : { ...b, phase: l.phase, activity: l.activity, frac: Math.max(b.frac, frac), calls: l.calls.map(c => ({ ...c })), spans: l.spans.map(sp => ({ ...sp })) },
    ),
  )
}

// needs_input on and off for the live turn; the sound plays once, on the way in
async function setWaiting($: EngineInterface, isWaiting: boolean, note: string | null) {
  const l = live
  const id = l?.turnId
  if (!l || !id) return
  // the wait is a stretch of its own on the timeline; waits happen around tool calls, so work resumes after
  markSpan(l, isWaiting ? 'waiting' : 'working', await $.clock.now())
  await flush($)
  let isEntered = false
  await update($, bars, list =>
    list.map(b => {
      if (b.id !== id || b.state !== (isWaiting ? 'running' : 'needs_input')) return b
      isEntered = isWaiting
      return { ...b, state: isWaiting ? ('needs_input' as const) : ('running' as const), note: isWaiting ? note : null }
    }),
  )
  if (isEntered) play($, 'decision')
}

function syncAgents(b: TurnBar, now: number): TurnBar {
  const agents = b.agents ?? []
  const isOver = agents.length > 0 && agents.every(a => a.state === 'done' || a.state === 'error')
  return { ...b, agentsDoneAt: isOver ? (b.agentsDoneAt ?? now) : null }
}

function addRun(b: TurnBar, run: AgentRun, parentId: string | undefined, now: number): TurnBar {
  // a batch that has finished makes room for the next one
  const list = b.agentsDoneAt ? [] : [...(b.agents ?? [])]
  let at = list.length
  const parentAt = parentId ? list.findIndex(a => a.id === parentId) : -1
  if (parentAt >= 0) {
    at = parentAt + 1
    while (at < list.length && (list[at]?.depth ?? 0) > 0) at++
  }
  list.splice(at, 0, run)
  return syncAgents({ ...b, agents: list, agentsDoneAt: null }, now)
}

// changes one agent's strip inside the latest list
async function editAgent($: EngineInterface, agentId: string, change: (a: AgentRun) => AgentRun) {
  const home = agentHome.get(agentId)
  if (!home) return
  const now = await $.clock.now()
  let isFolding = false
  await update($, bars, list =>
    list.map(b => {
      if (b.id !== home || !b.agents?.some(a => a.id === agentId)) return b
      const next = syncAgents({ ...b, agents: b.agents.map(a => (a.id === agentId ? change(a) : a)) }, now)
      isFolding = !b.agentsDoneAt && next.agentsDoneAt !== null
      return next
    }),
  )
  if (isFolding) foldUntil = now + FOLD_MS + 1500
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(1000, async () => {
      if (isTicking || agentHome.size > 0 || (await $.clock.now()) < foldUntil) await update($, tick, n => n + 1)
    })
    await $.command.register({ name: 'turnbar', description: 'Show or hide the turn progress bar' })
    await $.command.register({ name: 'turnbar-sounds', description: 'Play the decision, error and done sounds' })
    await $.command.register({ name: 'turnbar-clear', description: 'Remove the turn progress bar' })
    await $.command.register({ name: 'turnbar-timeline', description: 'Open the timeline of the latest turn' })

    return next(e)
  })

  // a main-loop turn opens a bar; subagents raise no turn.start
  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const line = firstLine(e.text)
    const isShort = !e.text.trim().includes('\n') && [...line].length <= SHORT_TITLE
    // an empty title draws as a placeholder until the name arrives
    const title = !line ? LABEL.untitled : isShort ? line : ''
    live = { turnId: e.turnId, phase: 'request', activity: LABEL.request, thinkChars: 0, stepText: 0, isStepTool: false, answerChars: 0, tools: 0, calls: [], spans: [] }
    const bar: TurnBar = {
      id: e.turnId,
      title,
      phase: 'request',
      activity: LABEL.request,
      state: 'running',
      frac: 0,
      calls: [],
      spans: [],
      note: null,
      startedAt: now,
      endedAt: null,
      tokens: null,
      agents: [],
      agentsDoneAt: null,
    }
    let kept: TurnBar[] = []
    await update($, bars, list => {
      // agents still running in the background move to the new bar, so their strips stay
      const carried = list.flatMap(b => (b.agents ?? []).filter(a => a.state === 'running' || a.state === 'waiting'))
      for (const a of carried) agentHome.set(a.id, e.turnId)
      kept = placeBar(list, { ...bar, agents: carried })
      return kept
    })
    for (const id of [...lastHead.keys()]) if (!kept.some(b => b.id === id)) lastHead.delete(id)
    isTicking = true
    if (!title) void nameTurn($, e.turnId, e.text).catch(() => undefined)

    return next(e)
  })

  // the main loop's stream moves the bar: thinking, tool calls, and a long enough text as the answer
  on('turn.step', async function* ($, e, next) {
    const l = live
    if (e.agentId || !l || l.turnId !== e.turnId) return yield* next(e)
    l.stepText = 0
    l.isStepTool = false
    let since = 0
    let flushedAt = 0
    for await (const c of next(e)) {
      yield c
      let isNow = false
      if (c.kind === 'thinking') {
        l.thinkChars += c.text.length
        if (l.activity !== LABEL.thinking) {
          isNow = true
          markSpan(l, 'thinking', await $.clock.now())
        }
        advance(l, 'thinking')
        l.activity = LABEL.thinking
      } else if (c.kind === 'text') {
        l.stepText += c.text.length
        if (!l.isStepTool && l.stepText >= ANSWER_MIN_CHARS) {
          if (l.activity !== LABEL.answering) {
            isNow = true
            markSpan(l, 'answering', await $.clock.now())
          }
          advance(l, 'answering')
          if (l.phase === 'answering') l.answerChars = l.stepText
          l.activity = LABEL.answering
        }
      } else if (c.kind === 'tool') {
        l.isStepTool = true
        l.tools += 1
        advance(l, 'working')
        l.activity = LABEL.working
        markSpan(l, 'working', await $.clock.now())
        l.calls = [...l.calls, { id: c.id, name: c.name, target: '', frac: fracOf(l), startedAt: null, endedAt: null, isError: false }].slice(-MAX_CALLS)
        isNow = true
      } else if (c.kind === 'stop') {
        isNow = true
      }
      since += 1
      if (!isNow && since < CLOCK_EVERY) continue
      since = 0
      const at = await $.clock.now()
      if (isNow || at - flushedAt >= FLUSH_MS) {
        flushedAt = at
        await flush($)
      }
    }
  })

  on('tool.call', async ($, e, next) => {
    // a subagent's call only names its current tool on its strip
    if (e.agentId) {
      const agentId = e.agentId
      if (!agentHome.has(agentId)) return next(e)
      await editAgent($, agentId, a => ({ ...a, state: 'running', tool: e.tool }))
      if (e.tool_use_id) toolUses.set(e.tool_use_id, agentId)
      const ran = await next(e)
      if (e.tool_use_id) toolUses.delete(e.tool_use_id)
      if (waiting.delete(agentId)) await editAgent($, agentId, a => (a.state === 'waiting' ? { ...a, state: 'running' } : a))
      return ran
    }
    const l = live
    if (!l) return next(e)
    // a question or a plan to approve waits on the person until the call returns
    if (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode') {
      await setWaiting($, true, e.tool === 'ExitPlanMode' ? LABEL.plan : LABEL.question)
      const ran = await next(e)
      await setWaiting($, false, null)
      return ran
    }
    const useId = e.tool_use_id
    if (useId) pendingMain.add(useId)
    // the call the stream announced now runs: its target, and when it began
    const target = targetOf(e as unknown as Record<string, unknown>)
    const startedAt = await $.clock.now()
    let call = l.calls.find(c => c.id === useId)
    if (!call) {
      call = { id: useId ?? `call-${l.calls.length}`, name: e.tool, target, frac: fracOf(l), startedAt, endedAt: null, isError: false }
      l.calls = [...l.calls, call].slice(-MAX_CALLS)
    }
    call.target = target
    call.startedAt = startedAt
    l.activity = LABEL.working
    await flush($)
    const ran = await next(e)
    call.endedAt = await $.clock.now()
    call.isError = ran.isError === true || ran.deny !== undefined
    if (useId) {
      pendingMain.delete(useId)
      if (waitingMain.delete(useId)) await setWaiting($, false, null)
    }
    if (live === l) await flush($)
    return ran
  })

  // a call held on a permission prompt turns the bar (or an agent's strip) amber until it goes on
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const useId = e.tool_use_id
    if (!useId || verdict.decision !== 'ask') return verdict
    const agentId = toolUses.get(useId)
    // the mode often settles an ask by itself in a blink; only a call still held after a moment waits on the person
    $.clock.after(ASK_DELAY_MS, async () => {
      if (agentId) {
        if (toolUses.get(useId) !== agentId) return
        waiting.add(agentId)
        await editAgent($, agentId, a => ({ ...a, state: 'waiting', tool: LABEL.approval }))
      } else if (pendingMain.has(useId)) {
        waitingMain.add(useId)
        await setWaiting($, true, LABEL.approval)
      }
    })

    return verdict
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!('agentId' in started) || !started.agentId) return started
    const parentHome = e.parentAgentId ? agentHome.get(e.parentAgentId) : undefined
    const home = parentHome ?? live?.turnId
    if (!home) return started
    const id = started.agentId
    const now = await $.clock.now()
    agentHome.set(id, home)
    const run: AgentRun = { id, title: (e.description || e.subagentType).slice(0, 60), state: 'running', tool: 'Starting', startedAt: now, endedAt: null, depth: parentHome ? 1 : 0 }
    await update($, bars, list => list.map(b => (b.id === home ? addRun(b, run, e.parentAgentId, now) : b)))

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      if (agentHome.has(agentId)) {
        const now = await $.clock.now()
        const isFailed = e.reason !== 'answer'
        const tool = e.reason === 'aborted' ? 'Stopped' : isFailed ? 'Failed' : 'Done'
        await editAgent($, agentId, a => ({ ...a, state: isFailed ? 'error' : 'done', tool, endedAt: now }))
        if (isFailed) play($, 'error')
        agentHome.delete(agentId)
        waiting.delete(agentId)
      }
      return next(e)
    }
    const l = live
    if (!l || l.turnId !== e.turnId) return next(e)
    live = null
    isTicking = false
    pendingMain.clear()
    waitingMain.clear()
    const now = await $.clock.now()
    const lastSpan = l.spans[l.spans.length - 1]
    if (lastSpan && lastSpan.end === null) lastSpan.end = now
    for (const c of l.calls) if (c.startedAt !== null && c.endedAt === null) c.endedAt = now
    const u = e.usage
    const tokens = u ? { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens } : null
    const state: TurnState = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'error'
    const note = e.reason === 'refusal' ? (e.refusal.explanation ?? LABEL.refused) : e.reason === 'error' ? LABEL.apiError : null
    await update($, bars, list =>
      list.map(b =>
        b.id !== e.turnId
          ? b
          : {
              ...b,
              state,
              note,
              activity: LABEL[state],
              frac: state === 'done' ? 1 : b.frac,
              phase: state === 'done' ? 'answering' : b.phase,
              endedAt: now,
              tokens,
              calls: l.calls.map(c => ({ ...c })),
              spans: l.spans.map(sp => ({ ...sp })),
            },
      ),
    )
    if (state === 'done' && e.durationMs >= DONE_SOUND_MIN_MS) play($, 'done')
    if (state === 'error') play($, 'error')

    return next(e)
  })

  on('command.run', { command: 'turnbar' }, async $ => {
    if ((await read($, bars)).length === 0) return { text: 'No bar yet: one appears with the next request.' }
    const open = await read($, isOpen)
    await update($, isOpen, () => !open)

    return { text: open ? 'Turn bar hidden.' : 'Turn bar shown.' }
  })

  on('command.run', { command: 'turnbar-timeline' }, async $ => {
    await $.ui.open({ id: PANE, title: LABEL.timeline })

    return { text: `${LABEL.timeline}을 열었습니다.` }
  })

  on('command.run', { command: 'turnbar-sounds' }, async $ => {
    play($, 'decision')
    $.clock.after(900, () => play($, 'error'))
    $.clock.after(1800, () => play($, 'done'))

    return { text: 'Sounds: decision, error, done.' }
  })

  on('command.run', { command: 'turnbar-clear' }, async $ => {
    lastHead.clear()
    lastStrip.clear()
    await update($, bars, () => [])

    return { text: 'Turn bar removed.' }
  })

  // always drawn, so the person sees the mod is loaded: plain text, since a Button's chip is taller than the footer
  // row and gets cut. While the bar shows it takes the colour of the turn's state, else it is dim.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const last = (await read($, bars)).at(-1)
    const open = await read($, isOpen)
    const { Box, Text } = $.ui.resolve(e)
    // other mods add their labels to modes beneath us; keep them
    const below = await next(e)
    const isActive = last !== undefined && open

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text key="turnbar-label" bold={isActive} color={isActive ? STATE_COLOR[last.state] : undefined} dimColor={!isActive}>
          {LABEL.button}
        </Text>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, bars)
    if (list.length === 0 || e.props.hasSurvey || !(await read($, isOpen))) return next(e)
    const t = $.ui.resolve(e)
    const { Box, Button, Text } = t
    const Svg = 'Svg' in t ? t.Svg : null
    const total = Math.max(320, (e.props.bodyColumns || 100) * 8)
    // a fixed title column, so the track does not move when a title arrives; every bar is pinned to the right edge
    // (fixed-width clock, close button) and the rows line up.
    // Desktop reports ~8 CSS px per column; glyph, gaps, clock and the timeline and close buttons take ~164 px.
    const titleWidth = Math.round(Math.max(120, Math.min(220, total * 0.22)))
    const trackW = Math.max(120, Math.min(1400, total - titleWidth - 164))
    await read($, tick)
    const now = await $.clock.now()
    // a hairline between bars, so each bar and its agent strips read as one group
    const divider = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="1"><rect width="${total}" height="1" fill="#808080" fill-opacity=".22"/></svg>`

    return (
      <Box flexDirection="column" gap={1}>
        {list.flatMap((b, i) => {
          const v = visibleAgents(b, now)
          const stripsH = v ? 5 + stripsHeight(v.shown.length + (v.hidden.length > 0 ? 1 : 0)) : 0
          const source = v
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="${trackW}" height="${TRACK_H + stripsH}">${trackSvg(b, trackW, now)}<g transform="translate(0 ${TRACK_H + 5})">${stripsSvg(v, trackW, now)}</g></svg>`
            : trackSvg(b, trackW, now)
          const line = i > 0 && Svg ? [<Svg key={`div-${b.id}`} source={divider} alt="" width={total} height={1} />] : []
          const color = STATE_COLOR[b.state]
          const time = clockText((b.endedAt ?? now) - b.startedAt)
          const count = pillCount(b)
          const agentsAlt = v ? `; agents: ${(b.agents ?? []).map(a => `${a.title} ${a.state}`).join(', ')}` : ''
          const alt = `${b.title}: ${pillName(b)}${count ? `, ${count}` : ''}, ${time}${agentsAlt}`
          const pct = Math.round((b.state === 'done' ? 1 : b.frac) * 100)
          const bar = `${'━'.repeat(Math.round(pct / 4))}${'─'.repeat(25 - Math.round(pct / 4))}`

          return [
            ...line,
            <Box key={`bar-${b.id}`} flexDirection="row" alignItems={v ? 'flex-start' : 'center'} gap={1}>
              <Text color={color}>{STATE_GLYPH[b.state]}</Text>
              {b.title ? <Text wrap="truncate">{b.title}</Text> : <Text dimColor>…</Text>}
              <Box flexGrow={1} />
              {Svg ? (
                <Svg source={source} alt={alt} width={trackW} height={TRACK_H + stripsH} isInteractive={isSettled(b) || undefined} />
              ) : (
                <Text>
                  <Text color={color}>{bar.replace(/─/g, '')}</Text>
                  <Text dimColor>{bar.replace(/━/g, '')}</Text>
                  <Text color={color}>{` ${pillName(b)}${count ? ` ${count}` : ''}`}</Text>
                </Text>
              )}
              <Text dimColor>{time.padStart(4, FIGURE_SPACE)}</Text>
              <Button key={`timeline-${b.id}`} plain dimColor label={LABEL.timelineButton} onPress={() => $.ui.open({ id: PANE, title: LABEL.timeline })} />
              <Button key={`close-${b.id}`} plain dimColor label="✕" onPress={() => update($, bars, all => all.filter(x => x.id !== b.id))} />
            </Box>,
          ]
        })}
      </Box>
    )
  })

  // the latest turn, opened by the ≡ button or /turnbar-timeline and live while the turn runs:
  // a head line, one bar of where the time went with its legend, then the calls and agents as plain rows
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text } = t
    const Svg = 'Svg' in t ? t.Svg : null
    const b = (await read($, bars)).at(-1)
    if (!b) return <Text dimColor>{LABEL.noTurn}</Text>
    await read($, tick)
    const now = await $.clock.now()
    const total = Math.max(1, (b.endedAt ?? now) - b.startedAt)
    const color = STATE_COLOR[b.state]
    const totals = spanTotals(b, now)
    const W = Math.max(200, (e.props.bodyColumns || 60) * 8 - 16)
    const calls = b.calls.filter(c => c.startedAt !== null)
    const lengthOf = (c: ToolRun) => (c.endedAt ?? now) - (c.startedAt ?? now)
    // a call that took a fifth of the turn or more is where the time went
    const isLong = (ms: number) => ms >= total * 0.2 && ms >= 2000
    const offset = (at: number) => `+${clockText(at - b.startedAt)}`.padStart(5, FIGURE_SPACE)
    const filled = Math.round((Math.min(total, SPAN_KINDS.reduce((n, k) => n + totals[k], 0)) / total) * 40)
    const textBar = SPAN_KINDS.flatMap(k => {
      const n = Math.round((totals[k] / total) * 40)
      return n > 0 ? [<Text key={`seg-${k}`} color={SPAN_COLOR[k]}>{'━'.repeat(n)}</Text>] : []
    })

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text color={color}>{STATE_GLYPH[b.state]}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text bold wrap="truncate">{b.title || '…'}</Text>
          </Box>
          <Text color={color}>{pillName(b)}</Text>
          <Text dimColor>{clockText(total)}</Text>
        </Box>
        <Box flexDirection="column">
          {Svg ? (
            <Svg source={phaseBarSvg(b, W, now)} alt={SPAN_KINDS.map(k => `${SPAN_LABEL[k]} ${durationText(totals[k])}`).join(', ')} width={W} height={PHASE_BAR_H} isInteractive={isSettled(b) || undefined} />
          ) : (
            <Text>
              {textBar}
              <Text dimColor>{'─'.repeat(Math.max(0, 40 - filled))}</Text>
            </Text>
          )}
          <Box flexDirection="row" gap={2}>
            {SPAN_KINDS.filter(k => totals[k] > 0).map(k => (
              <Text key={`legend-${k}`}>
                <Text color={SPAN_COLOR[k]}>● </Text>
                <Text dimColor>{`${SPAN_SHORT[k]} ${durationText(totals[k])}`}</Text>
              </Text>
            ))}
          </Box>
        </Box>
        <Box flexDirection="column">
          <Text dimColor>{`${LABEL.calls} ${calls.length}`}</Text>
          {calls.map(c => {
            const ms = lengthOf(c)
            return (
              <Box key={c.id} flexDirection="row" gap={1}>
                <Text dimColor>{offset(c.startedAt ?? b.startedAt)}</Text>
                <Text color={c.isError ? STATE_COLOR.error : STATE_COLOR.running}>{c.name}</Text>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate" dimColor={!isLong(ms)}>{c.target}</Text>
                </Box>
                <Text bold={isLong(ms)} dimColor={!isLong(ms)} color={c.isError ? STATE_COLOR.error : undefined}>
                  {c.endedAt === null ? `${LABEL.running} ${durationText(ms)}` : c.isError ? `${LABEL.failed} ${durationText(ms)}` : durationText(ms)}
                </Text>
              </Box>
            )
          })}
          {(b.agents ?? []).map(a => {
            const ms = (a.endedAt ?? now) - a.startedAt
            return (
              <Box key={`agent-${a.id}`} flexDirection="row" gap={1}>
                <Text dimColor>{offset(a.startedAt)}</Text>
                <Text color={AGENT_COLOR[a.state]}>{`↳ ${LABEL.agents}`}</Text>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate" dimColor={!isLong(ms)}>{a.title}</Text>
                </Box>
                <Text bold={isLong(ms)} dimColor={!isLong(ms)}>{durationText(ms)}</Text>
              </Box>
            )
          })}
        </Box>
        {b.tokens ? <Text dimColor>{tokensText(b)}</Text> : null}
      </Box>
    )
  })
}
```

### A.5 `tsconfig.json`

엔진은 모드를 로드할 때마다 `.claude-plugin/types/`에 현재 빌드의 API 타입(`claude-code/index.d.ts`)과 거기에 맞는 `tsconfig.json`을 써 둔다. 루트 tsconfig는 그 파일을 확장하기만 한다. 아직 한 번도 로드하지 않았다면 `claude --plugin-dir .`로 한 번 띄우면 그 폴더가 생긴다.

```json
{
  "extends": "./.claude-plugin/types/tsconfig.json"
}
```
