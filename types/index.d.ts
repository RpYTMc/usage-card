/** One local day of activity, as scripts/stats.mjs counts it. */
export type DayStats = {
  /** Messages: prompts plus assistant replies (top-level chats). */
  m: number
  /** Tokens: input + output + cache write + cache read, subagents included. */
  t: number
  /** Sessions whose first message fell on this day. */
  s: number
  /** Messages by local hour, 24 entries. */
  h: number[]
  /** Tokens by model id. */
  models: Record<string, number>
}

/** What the card draws from. */
export type StatsData = {
  /** This machine's local date when the stats were made, YYYY-MM-DD. */
  today: string
  /** When they were made, ms since the epoch. */
  generatedAt: number
  /** Activity by local date, YYYY-MM-DD. */
  days: Record<string, DayStats>
}

/** Which tab and range one card shows. */
export type CardView = {
  tab: 'overview' | 'models'
  range: 'all' | '30d' | '7d'
}

/** The prompt that opened a fresh chat: the card is drawn above it. */
export type FirstPrompt = { uuid: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-card': {
      stats: Shaped<StatsData | null>
      view: StateFamily<CardView>
      first: FirstPrompt | null
      isFresh: boolean
    }
  }
}
