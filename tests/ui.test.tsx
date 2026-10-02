import { expect, mock, test } from 'claude-code/testing'

// the surfaces validate every tree the hooks return; a tree they refuse fails `drawn()`
const SURFACES = ['terminal', 'desktop'] as const
const scroll = { top: 0, bodyRows: 20, contentRows: 0 } as never
const view = {} as never

test('a turn with a tool call draws the bar and the footer label on every surface', async ($, on) => {
  mock.clock(on)
  // the engine beneath the plugin: an empty drawing, and a tool that answers at once
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.start({ text: '타입 검사 돌려줘', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npx tsc -p .', description: '타입 검사' } as never)
  await $.turn.complete({
    turnId: 't1',
    reason: 'answer',
    answer: '통과했습니다.',
    durationMs: 4000,
    isAborted: false,
    usage: { model: 'test', input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
  } as never)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'turn-progress', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll } as never })
    expect(await band.find({ type: 'Text', text: /타입 검사 돌려줘/ })).toBeDefined()
    if (surface === 'terminal') {
      // the finished turn: a full dithered bar and its share
      expect(await band.find({ type: 'Text', text: /^▓{8,}$/ })).toBeDefined()
      expect(await band.find({ type: 'Text', text: /100%/ })).toBeDefined()
    }
    await band.unmount()
    const footer = await $.ui.mount({ plugin: 'turn-progress', surface, component: 'SessionMode', props: { modes: [] } })
    expect(await footer.find({ type: 'Text', text: /^Progress$/ })).toBeDefined()
    await footer.unmount()
  }
})

test('a background agent that finishes shows as done in the turn its notification starts', async ($, on) => {
  mock.clock(on)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'ag1' }) as never)

  await $.turn.start({ text: '조사해줘', turnId: 't1' })
  await $.agent.spawn({ prompt: 'look', description: '파일 조사', subagentType: 'Explore', background: true } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1000, isAborted: false } as never)
  // the agent ends, and its notification starts the next turn right away
  await $.turn.complete({ turnId: 'a1', agentId: 'ag1', reason: 'answer', answer: 'ok', durationMs: 5000, isAborted: false } as never)
  await $.turn.start({ text: '', turnId: 't2' })

  const band = await $.ui.mount({ plugin: 'turn-progress', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 120, scroll } as never })
  expect(await band.find({ type: 'Text', text: /파일 조사/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^ 완료\s*$/ })).toBeDefined()
  await band.unmount()
})
