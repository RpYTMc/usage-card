import { atom, memberOf, read, update } from 'claude-code'
import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  EngineInterface,
  Register,
  RenderElement,
  RenderInput,
  TextProps,
} from 'claude-code'

import type { CardView, DayStats, FirstPrompt, StatsData } from '../types'

const COMMAND = 'usage-card'
const PANE_COMMAND = 'usage-pane'
const DEFAULT_VIEW: CardView = { tab: 'overview', range: 'all' }

// Bump a shape tag when that value's fields change: what an older version
// stored then reads as the initial value instead of a wrong shape.
const stats = atom({ plugin: 'usage-card', key: 'stats' } as const, null, { shape: 'stats-1' })
const view = atom({ plugin: 'usage-card', key: 'view' } as const, DEFAULT_VIEW)
const first = atom({ plugin: 'usage-card', key: 'first' } as const, null)
const isFresh = atom({ plugin: 'usage-card', key: 'isFresh' } as const, false)

// ---------- the numbers ----------

function isStatsData(v: unknown): v is StatsData {
  const s = v as StatsData | null
  return !!s && typeof s.today === 'string' && typeof s.generatedAt === 'number' && !!s.days && typeof s.days === 'object'
}

/** Runs scripts/stats.mjs (incremental: only changed transcripts are read) and keeps the result. */
async function refreshStats($: EngineInterface): Promise<StatsData | null> {
  try {
    const script = `${$.plugin.root}/scripts/stats.mjs`
    const run = await $.process.run(['node', script], { timeoutMs: 180_000 })
    if (run.exitCode !== 0) {
      $.ui.log(`usage-card: stats script failed (${run.exitCode}): ${run.stderr.slice(0, 300)}`)
      return null
    }
    const parsed: unknown = JSON.parse(run.stdout)
    if (!isStatsData(parsed)) return null
    const data: StatsData = { today: parsed.today, generatedAt: parsed.generatedAt, days: parsed.days }
    await update($, stats, () => data)
    await $.store.set('stats', data)
    return data
  } catch (err) {
    $.ui.log(`usage-card: could not read stats: ${String(err).slice(0, 300)}`)
    return null
  }
}

function shiftDay(day: string, delta: number): string {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86_400_000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/** 0 = Monday ... 6 = Sunday. */
function weekday(day: string): number {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number)
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

type Totals = {
  sessions: number
  messages: number
  tokens: number
  activeDays: number
  peakHour: number | null
  models: [string, number][]
}

function totals(data: StatsData, range: CardView['range']): Totals {
  const from = range === 'all' ? '' : shiftDay(data.today, range === '30d' ? -29 : -6)
  const hours = new Array<number>(24).fill(0)
  const models: Record<string, number> = {}
  const out: Totals = { sessions: 0, messages: 0, tokens: 0, activeDays: 0, peakHour: null, models: [] }
  for (const [day, r] of Object.entries(data.days)) {
    if (day < from || day > data.today) continue
    out.sessions += r.s
    out.messages += r.m
    out.tokens += r.t
    if (r.m > 0 || r.t > 0) out.activeDays += 1
    r.h.forEach((n, i) => (hours[i] = (hours[i] ?? 0) + n))
    for (const [id, n] of Object.entries(r.models)) models[id] = (models[id] ?? 0) + n
  }
  const peak = Math.max(...hours)
  out.peakHour = peak > 0 ? hours.indexOf(peak) : null
  out.models = Object.entries(models).sort((a, b) => b[1] - a[1])
  return out
}

// ---------- formatting ----------

function grouped(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function short(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

function hourText(h: number | null): string {
  if (h === null) return '–'
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve} ${h < 12 ? 'AM' : 'PM'}`
}

/** claude-opus-5-5 -> Opus 5.5, claude-3-5-sonnet-20241022 -> Sonnet 3.5. */
function modelName(id: string): string {
  const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-')
  const family = parts.find(p => !/^\d+$/.test(p))
  const version = parts.filter(p => /^\d+$/.test(p)).join('.')
  if (!family) return id
  return `${family[0]?.toUpperCase() ?? ''}${family.slice(1)}${version ? ` ${version}` : ''}`
}

const BOOKS: [string, number][] = [
  ['The Lord of the Rings', 576_459],
  ['The Hobbit', 95_356],
]

function funLine(tokens: number): string {
  for (const [title, size] of BOOKS) {
    const times = tokens / size
    if (times >= 2) return `You've used ~${grouped(times)}× more tokens than ${title}.`
  }
  return tokens > 0 ? `You've used ${grouped(tokens)} tokens so far.` : 'No tokens used in this range yet.'
}

function summaryText(data: StatsData): string {
  const t = totals(data, 'all')
  const fav = t.models[0]
  return (
    `Claude Code usage, all time: ${grouped(t.sessions)} sessions, ${grouped(t.messages)} messages, ` +
    `${short(t.tokens)} tokens, ${t.activeDays} active days, peak hour ${hourText(t.peakHour)}` +
    (fav ? `, favorite model ${modelName(fav[0])}.` : '.')
  )
}

// ---------- layout ----------

/** How one drawing lays the card out: in the chat, or in the side pane. */
type Layout = {
  /** Weeks of heatmap, newest on the right. */
  weeks: number
  /** Heatmap square and gap, CSS pixels (pictures only). */
  cell: number
  gap: number
  /** Tiles per row. */
  perRow: 2 | 3
  /** The pane frames the card itself: no border, full width. */
  isPane: boolean
}

const CHAT: Layout = { weeks: 26, cell: 14, gap: 3, perRow: 3, isPane: false }
const PANE = 'usage'
/** The pane width asked of the surface, in cells; the app may keep its own. */
const PANE_COLUMNS = 44
/** The pane's content never grows past this, however wide the app makes the pane. */
const PANE_MAX_PX = 300

/** The pane's layout from the cells its body has (a desktop cell is about 7 px wide). */
function paneLayout(columns: number | undefined, isTerminal: boolean): Layout {
  const cols = columns ?? 40
  if (isTerminal) {
    return { weeks: Math.max(8, Math.min(26, cols - 4)), cell: 0, gap: 0, perRow: cols >= 60 ? 3 : 2, isPane: true }
  }
  const cell = 11
  const gap = 3
  const px = Math.min(cols * 7 - 16, PANE_MAX_PX)
  return {
    weeks: Math.max(8, Math.min(26, Math.floor((px + gap) / (cell + gap)))),
    cell,
    gap,
    perRow: 2,
    isPane: true,
  }
}

function heatmapSize(L: Layout): { w: number; h: number } {
  return { w: L.weeks * (L.cell + L.gap) - L.gap, h: 7 * (L.cell + L.gap) - L.gap }
}

// ---------- pictures (desktop, vscode, mobile) ----------

function heatmapSvg(data: StatsData, L: Layout): string {
  const start = shiftDay(data.today, -(weekday(data.today) + (L.weeks - 1) * 7))
  const counts: number[] = []
  for (const r of Object.values(data.days)) if (r.m > 0) counts.push(r.m)
  counts.sort((a, b) => a - b)
  const q = (p: number) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))] ?? 0
  const cuts = [q(0.25), q(0.5), q(0.75)]
  const level = (n: number) => (n <= 0 ? 0 : n <= (cuts[0] ?? 0) ? 1 : n <= (cuts[1] ?? 0) ? 2 : n <= (cuts[2] ?? 0) ? 3 : 4)
  const opacity = [0, 0.4, 0.6, 0.8, 1]
  const radius = L.cell >= 14 ? 3 : 2

  let cells = ''
  for (let c = 0; c < L.weeks; c++) {
    for (let r = 0; r < 7; r++) {
      const day = shiftDay(start, c * 7 + r)
      if (day > data.today) continue
      const n = data.days[day]?.m ?? 0
      const lv = level(n)
      const x = c * (L.cell + L.gap)
      const y = r * (L.cell + L.gap)
      const fill = lv === 0 ? 'fill="rgba(128,128,128,0.18)"' : `fill="#7aa7f0" fill-opacity="${opacity[lv]}"`
      const ring = day === data.today ? ' stroke="#3b82f6" stroke-width="2"' : ''
      cells += `<rect x="${x}" y="${y}" width="${L.cell}" height="${L.cell}" rx="${radius}" ${fill}${ring}><title>${day}: ${n} messages</title></rect>`
    }
  }
  const { w: width, h: height } = heatmapSize(L)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${cells}</svg>`
}

function barSvg(share: number, px: number): string {
  const barH = 8
  const fill = Math.max(0, Math.min(1, share)) * px
  const filled = fill > 0 ? `<rect width="${Math.max(fill, barH).toFixed(1)}" height="${barH}" rx="4" fill="#7aa7f0"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${barH}" viewBox="0 0 ${px} ${barH}"><rect width="${px}" height="${barH}" rx="4" fill="rgba(128,128,128,0.22)"/>${filled}</svg>`
}

// ---------- pictures (terminal) ----------

function heatmapRows(data: StatsData, weeks: number): string[] {
  const start = shiftDay(data.today, -(weekday(data.today) + (weeks - 1) * 7))
  const max = Math.max(1, ...Object.values(data.days).map(r => r.m))
  const glyphs = ['·', '░', '▒', '▓', '█']
  const rows: string[] = []
  for (let r = 0; r < 7; r++) {
    let line = ''
    for (let c = 0; c < weeks; c++) {
      const day = shiftDay(start, c * 7 + r)
      if (day > data.today) {
        line += ' '
        continue
      }
      const n = data.days[day]?.m ?? 0
      line += n === 0 ? glyphs[0] : glyphs[Math.min(4, 1 + Math.floor((n / max) * 3.999))]
    }
    rows.push(line)
  }
  return rows
}

function textBar(share: number): string {
  const cells = 20
  const filled = Math.round(Math.max(0, Math.min(1, share)) * cells)
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

// ---------- the card ----------

type Parts = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  heatmap: (data: StatsData) => RenderElement
  bar: (share: number, alt: string) => RenderElement
}

const TILE_BG = 'rgba(128,128,128,0.12)'

function card(
  data: StatsData | null,
  v: CardView,
  setView: (next: Partial<CardView>) => Promise<unknown>,
  { Box, Text, Button, heatmap, bar }: Parts,
  L: Layout,
): RenderElement {
  const chip = (key: string, label: string, isOn: boolean, onPress: () => Promise<unknown>) =>
    isOn ? (
      <Button key={key} label={label} variant="primary" onPress={onPress} />
    ) : (
      <Button key={key} label={label} plain onPress={onPress} />
    )

  const header = (
    <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap="md" rowGap="xs">
      <Box flexDirection="row" gap="xs">
        {chip('tab-overview', 'Overview', v.tab === 'overview', () => setView({ tab: 'overview' }))}
        {chip('tab-models', 'Models', v.tab === 'models', () => setView({ tab: 'models' }))}
      </Box>
      <Box flexDirection="row" gap="xs">
        {chip('range-all', 'All', v.range === 'all', () => setView({ range: 'all' }))}
        {chip('range-30d', '30d', v.range === '30d', () => setView({ range: '30d' }))}
        {chip('range-7d', '7d', v.range === '7d', () => setView({ range: '7d' }))}
      </Box>
    </Box>
  )

  // The card hugs its widest row (the heatmap), as the old /stats card did:
  // flex-start in a column parent shrinks it to its content. In the pane it
  // hugs too, without a border of its own (the pane is the frame).
  const frame = (inner: RenderElement) =>
    L.isPane ? (
      <Box flexDirection="column">
        <Box flexDirection="column" alignSelf="flex-start" gap="sm">
          {inner}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Box
          flexDirection="column"
          alignSelf="flex-start"
          borderStyle="round"
          borderColor="subtle"
          paddingX="md"
          paddingY="sm"
          gap="sm"
        >
          {inner}
        </Box>
      </Box>
    )

  if (data === null) {
    return frame(
      <>
        {header}
        <Text dimColor>Reading your chat history…</Text>
      </>,
    )
  }

  const t = totals(data, v.range)
  const fav = t.models[0]
  // The same basis for every tile, so the rows line up whatever the values' lengths.
  const tileWidth = L.perRow === 3 ? '33%' : '50%'
  const tile = (label: string, value: string) => (
    <Box flexDirection="column" width={tileWidth} flexGrow={1} flexShrink={1} paddingX="sm" paddingY="xs" backgroundColor={TILE_BG}>
      <Text size="caption" dimColor>
        {label}
      </Text>
      <Text weight="bold" tabular>
        {value}
      </Text>
    </Box>
  )
  const tiles = [
    tile('Sessions', grouped(t.sessions)),
    tile('Messages', grouped(t.messages)),
    tile('Total tokens', short(t.tokens)),
    tile('Active days', grouped(t.activeDays)),
    tile('Peak hour', hourText(t.peakHour)),
    tile('Favorite model', fav ? modelName(fav[0]) : '–'),
  ]
  const tileRows: RenderElement[] = []
  for (let i = 0; i < tiles.length; i += L.perRow) {
    tileRows.push(
      <Box flexDirection="row" gap="sm">
        {tiles.slice(i, i + L.perRow)}
      </Box>,
    )
  }

  const body =
    v.tab === 'overview' ? (
      <Box flexDirection="column" gap="sm">
        {tileRows}
        {heatmap(data)}
        <Text size="caption" dimColor>
          {funLine(t.tokens)}
        </Text>
      </Box>
    ) : (
      <Box flexDirection="column" gap="sm">
        {t.models.length === 0 && <Text dimColor>No model use in this range.</Text>}
        {t.models.slice(0, 8).map(([id, n]) => {
          const share = t.tokens > 0 ? n / t.tokens : 0
          return (
            <Box flexDirection="column" gap="xs">
              <Box flexDirection="row" justifyContent="space-between" gap="md">
                <Text size="footnote">{modelName(id)}</Text>
                <Text size="footnote" tabular dimColor>
                  {short(n)} · {Math.round(share * 100)}%
                </Text>
              </Box>
              {bar(share, `${modelName(id)}: ${Math.round(share * 100)}% of tokens`)}
            </Box>
          )
        })}
      </Box>
    )

  return frame(
    <>
      {header}
      {body}
    </>,
  )
}

/** The card for one drawing, on its surface, in the layout given. */
async function draw($: EngineInterface, e: RenderInput, L: Layout): Promise<RenderElement> {
  const data = await read($, stats)
  const mine = memberOf(view, e)
  const v = (await read($, mine)) ?? DEFAULT_VIEW
  const setView = (patch: Partial<CardView>) => update($, mine, old => ({ ...(old ?? DEFAULT_VIEW), ...patch }))

  if (e.surface === 'terminal') {
    const { Box, Text, Button } = $.ui.resolve(e)
    return card(
      data,
      v,
      setView,
      {
        Box,
        Text,
        Button,
        heatmap: d => (
          <Box flexDirection="column">
            {heatmapRows(d, L.weeks).map(row => (
              <Text color="suggestion">{row}</Text>
            ))}
          </Box>
        ),
        bar: share => <Text color="suggestion">{textBar(share)}</Text>,
      },
      L,
    )
  }

  const { Box, Text, Button, Svg } = $.ui.resolve(e)
  const { w: heatW, h: heatH } = heatmapSize(L)
  const barPx = Math.min(240, heatW)
  return card(
    data,
    v,
    setView,
    {
      Box,
      Text,
      Button,
      heatmap: d => (
        <Svg source={heatmapSvg(d, L)} alt={`Activity over the last ${L.weeks} weeks`} width={heatW} height={heatH} isInteractive />
      ),
      bar: (share, alt) => <Svg source={barSvg(share, barPx)} alt={alt} width={barPx} height={8} />,
    },
    L,
  )
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show your Claude Code usage stats (sessions, messages, tokens, activity)',
    })
    await $.command.register({
      name: PANE_COMMAND,
      description: 'Open the usage stats side pane again',
    })
    const started = await next(e)

    // Show the last stats at once; the fresh ones replace them when ready.
    if ((await read($, stats)) === null) {
      const cached = await $.store.get('stats')
      if (isStatsData(cached)) await update($, stats, () => cached)
    }
    $.clock.after(50, () => void refreshStats($))

    // The side pane, in every session. With no surface attached yet (the desktop
    // app attaches after the start) it stays open and is seated when one does.
    void $.ui.open({ id: PANE, title: 'Usage', columns: PANE_COLUMNS })

    // A brand-new chat (not a resume, not a reload of this mod) gets the card above its first message.
    const messages = await $.session.messages()
    if (Array.isArray(messages) && messages.length === 0) {
      await update($, isFresh, () => true)
      await update($, first, () => null)
    }

    return started
  })

  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    if (e.agentId === undefined && (await read($, isFresh)) && (await read($, first)) === null) {
      const content = e.message.content
      const text =
        typeof content === 'string'
          ? content
          : content.flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n')
      const opener: FirstPrompt = { uuid: e.uuid, text }
      await update($, first, () => opener)
    }

    return next(e)
  })

  on('command.run', { command: PANE_COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: 'Usage', columns: PANE_COLUMNS })

    return {}
  })

  on('command.run', { command: COMMAND }, async $ => {
    const data = (await refreshStats($)) ?? (await read($, stats))

    return { text: data ? summaryText(data) : 'Usage stats are not available yet.' }
  })

  // The card above the first message of a new chat (the app starts a session only when that message is sent).
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const opener = await read($, first)
    if (opener === null || !(e.requestId === opener.uuid || (opener.text !== '' && e.props.text === opener.text))) {
      return next(e)
    }
    const row = await next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap="md">
        {await draw($, e, CHAT)}
        {row}
      </Box>
    )
  })

  // /usage-card: the card in place of the command's text row.
  on('ui.render', { component: 'CommandOutput', props: { command: COMMAND } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)

    return draw($, e, CHAT)
  })

  // The side pane: the same card, laid out for the pane's width.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    draw($, e, paneLayout(e.props.bodyColumns, e.surface === 'terminal')),
  )
}
