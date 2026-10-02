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
