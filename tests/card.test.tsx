import { expect, mock, test } from 'claude-code/testing'

const hours = (at: number, n: number) => Array.from({ length: 24 }, (_, i) => (i === at ? n : 0))

const DATA = {
  today: '2026-11-10',
  generatedAt: Date.parse('2026-11-10T17:00:00Z'),
  days: {
    '2026-07-05': { m: 100, t: 1_000_000, s: 2, h: hours(1, 100), models: { 'claude-fable-5-1': 1_000_000 } },
    '2026-11-01': { m: 40, t: 600_000_000, s: 1, h: hours(18, 40), models: { 'claude-opus-5-5': 600_000_000 } },
    '2026-11-10': { m: 10, t: 4_000_000, s: 1, h: hours(1, 10), models: { 'claude-opus-5-5': 4_000_000 } },
  },
}

const RUN = {
  value: { exitCode: 0, stdout: JSON.stringify(DATA), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
}

const USAGE_CARD = {
  command: 'usage-card',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

const OUTPUT = {
  plugin: 'usage-card',
  component: 'CommandOutput',
  requestId: 'out-1',
  props: { command: 'usage-card', args: '', text: 'x', isErrored: false },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

test('/usage-card draws the overview card on every surface', async ($, on) => {
  mock.store(on)
  on('process.run', () => RUN)

  const ran = await $.command.run(USAGE_CARD)
  expect(ran.text).toBe(
    'Claude Code usage, all time: 4 sessions, 150 messages, 605.0M tokens, 3 active days, peak hour 1 AM, favorite model Opus 5.5.',
  )

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...OUTPUT, surface })
    expect((await ui.find({ type: 'Text', text: /^150$/ }))?.text).toBe('150')
    expect((await ui.find({ type: 'Text', text: /^605\.0M$/ }))?.text).toBe('605.0M')
    expect((await ui.find({ type: 'Text', text: /^1 AM$/ }))?.text).toBe('1 AM')
    expect((await ui.find({ type: 'Text', text: /^Opus 5\.5$/ }))?.text).toBe('Opus 5.5')
    expect((await ui.find({ type: 'Text', text: /Lord of the Rings/ }))?.text).toBe(
      "You've used ~1,050× more tokens than The Lord of the Rings.",
    )
    await ui.unmount()
  }
})

test('the 7d range and the Models tab', async ($, on) => {
  mock.store(on)
  on('process.run', () => RUN)
  await $.command.run(USAGE_CARD)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...OUTPUT, requestId: `out-${surface}`, surface })
    await ui.press({ key: 'range-7d' })
    expect((await ui.find({ type: 'Text', text: /^10$/ }))?.text).toBe('10')
    expect((await ui.find({ type: 'Text', text: /^4\.0M$/ }))?.text).toBe('4.0M')

    await ui.press({ key: 'tab-models' })
    expect((await ui.find({ type: 'Text', text: /^Opus 5\.5$/ }))?.text).toBe('Opus 5.5')
    expect(await ui.find({ type: 'Text', text: /^Sessions$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the first message of a new chat gets the card above it', async ($, on) => {
  mock.store(on)
  on('process.run', () => RUN)
  on('state.get', { plugin: 'usage-card', key: 'first' }, () => ({
    value: { value: { uuid: 'msg-1', text: 'hello' }, version: 1 },
  }))
  await $.command.run(USAGE_CARD)

  const row = {
    plugin: 'usage-card',
    component: 'UserMessage',
    props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false },
  } as const

  const opener = await $.ui.mount({ ...row, requestId: 'msg-1', surface: 'desktop' })
  expect((await opener.find({ type: 'Text', text: /^Sessions$/ }))?.text).toBe('Sessions')
  await opener.unmount()

  const later = await $.ui.mount({ ...row, requestId: 'msg-2', props: { ...row.props, text: 'later' }, surface: 'desktop' })
  expect(await later.find({ type: 'Text', text: /^Sessions$/ })).toBeUndefined()
  await later.unmount()
})

test('every session opens the side pane, which draws the card at its width', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: DATA.generatedAt })
  let opened = 0
  on('process.run', () => RUN)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('ui.open', () => {
    opened += 1
    return { value: { isPlaced: true } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened).toBe(1)
  await $.command.run(USAGE_CARD)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-card',
      component: 'Pane',
      requestId: 'usage',
      surface,
      props: {
        title: 'Usage',
        isFocused: false,
        bodyColumns: 40,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    expect((await ui.find({ type: 'Text', text: /^Favorite model$/ }))?.text).toBe('Favorite model')
    expect((await ui.find({ type: 'Text', text: /^150$/ }))?.text).toBe('150')
    await ui.unmount()
  }
})
