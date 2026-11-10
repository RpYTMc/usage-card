// Usage stats from Claude Code's local transcripts, for the usage-card mod.
//
//   node stats.mjs            -> prints the merged stats as one JSON line
//
// Reads <config>/projects/**/*.jsonl (config = CLAUDE_CONFIG_DIR or ~/.claude).
// Each file's summary is cached in <config>/state/usage-card-stats.json by
// size + mtime, so only files that changed since the last run are read again.
//
// Counting:
//   sessions  top-level transcripts (projects/<project>/<id>.jsonl) with a prompt,
//             on the day of their first message
//   messages  prompts (user rows that are not tool results or meta) plus
//             assistant replies (unique message ids), top-level transcripts only
//   tokens    input + output + cache write + cache read of every assistant reply,
//             subagent transcripts included
//   dates     local time of this machine
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const VERSION = 1
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const projectsDir = path.join(configDir, 'projects')
const cacheFile = path.join(configDir, 'state', 'usage-card-stats.json')

function localDay(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function listTranscripts(dir) {
  const out = []
  let projects = []
  try {
    projects = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const walk = (folder, depth) => {
      let entries = []
      try {
        entries = fs.readdirSync(folder, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(folder, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: full, isSession: depth === 0 })
      }
    }
    walk(path.join(dir, p.name), 0)
  }
  return out
}

function emptyDay() {
  return { m: 0, t: 0, s: 0, h: new Array(24).fill(0), models: {} }
}

async function summarize(file, isSession) {
  const days = {}
  const replies = new Map() // message id -> { day, hour, model, tokens }
  let firstDay = null
  let hasPrompt = false
  const at = ts => {
    const d = new Date(ts)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const bump = (day, hour, field, n) => {
    const row = (days[day] ??= emptyDay())
    row[field] += n
    if (field === 'm') row.h[hour] += n
  }

  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const line of rl) {
    const isAssistant = line.includes('"type":"assistant"')
    const isUser = !isAssistant && line.includes('"type":"user"')
    if (!isAssistant && !isUser) continue
    if (isUser && (!isSession || line.includes('"tool_result"') || line.includes('"isMeta":true'))) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const d = at(row.timestamp)
    if (!d) continue
    const day = localDay(d)
    const hour = d.getHours()

    if (row.type === 'user' && isSession) {
      const content = row.message?.content
      const isPrompt =
        typeof content === 'string' ||
        (Array.isArray(content) && content.some(b => b?.type === 'text') && !content.some(b => b?.type === 'tool_result'))
      if (!isPrompt || row.isMeta) continue
      hasPrompt = true
      firstDay ??= day
      bump(day, hour, 'm', 1)
    } else if (row.type === 'assistant') {
      const msg = row.message
      const id = msg?.id
      const model = msg?.model
      if (!id || !model || model === '<synthetic>') continue
      const u = msg.usage ?? {}
      const tokens =
        (u.input_tokens ?? 0) +
        (u.output_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0)
      // A reply is written once per content block; the last line holds its final usage.
      replies.set(id, { day, hour, model, tokens })
      if (isSession) firstDay ??= day
    }
  }

  for (const r of replies.values()) {
    const row = (days[r.day] ??= emptyDay())
    row.t += r.tokens
    row.models[r.model] = (row.models[r.model] ?? 0) + r.tokens
    if (isSession) {
      row.m += 1
      row.h[r.hour] += 1
    }
  }
  if (isSession && hasPrompt && firstDay) (days[firstDay] ??= emptyDay()).s += 1
  return days
}

async function main() {
  let cache = { version: VERSION, files: {} }
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    if (c?.version === VERSION && c.files) cache = c
  } catch {}

  const found = listTranscripts(projectsDir)
  const next = { version: VERSION, files: {} }
  let scanned = 0
  for (const { file, isSession } of found) {
    let st
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    const old = cache.files[file]
    if (old && old.size === st.size && old.mtimeMs === st.mtimeMs && old.isSession === isSession) {
      next.files[file] = old
      continue
    }
    try {
      next.files[file] = { size: st.size, mtimeMs: st.mtimeMs, isSession, days: await summarize(file, isSession) }
      scanned += 1
    } catch {}
  }

  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    const tmp = `${cacheFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next))
    fs.renameSync(tmp, cacheFile)
  } catch {}

  const days = {}
  for (const f of Object.values(next.files)) {
    for (const [day, r] of Object.entries(f.days)) {
      const row = (days[day] ??= emptyDay())
      row.m += r.m
      row.t += r.t
      row.s += r.s
      for (let i = 0; i < 24; i++) row.h[i] += r.h[i] ?? 0
      for (const [model, n] of Object.entries(r.models)) row.models[model] = (row.models[model] ?? 0) + n
    }
  }

  process.stdout.write(
    JSON.stringify({ today: localDay(new Date()), generatedAt: Date.now(), files: found.length, scanned, days }),
  )
}

main().catch(err => {
  process.stderr.write(String(err?.stack ?? err))
  process.exit(1)
})
