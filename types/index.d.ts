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
// one tool call of the main loop: a tick on the track with its tooltip
export type ToolRun = {
  id: string // tool_use_id
  name: string
  target: string // the file, command or query it works on; '' until the call runs
  frac: number // where on the track its tick sits
  startedAt: number | null // when it began to run; null while the model still writes it
  endedAt: number | null
  isError: boolean
}
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
