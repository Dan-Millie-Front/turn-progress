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
    expect(await footer.find({ type: 'Text', text: /Progress/ })).toBeDefined()
    await footer.unmount()
  }
})
