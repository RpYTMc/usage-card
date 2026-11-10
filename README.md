# usage-card

A Claude Code mod that brings back the usage stats card: how much you've used Claude Code, shown as a card at the start of every chat and in a side pane.

- **Overview tab:** sessions, messages, total tokens, active days, peak hour and favorite model, a 26-week activity heatmap, and how many times over you've used The Lord of the Rings in tokens.
- **Models tab:** each model's share of your tokens.
- **All / 30d / 7d** to change the range.

## Where it shows up

- **Above the first message of every new chat.** The desktop app only starts Claude Code when you send the first message, so the card appears then, at the top of the chat.
- **In a "Usage" side pane**, opened in every session. Closed it? `/usage-pane` opens it again.
- **Anywhere you type `/usage-card`**, in place of the command's output.

## Requirements

- A Claude Code version with hooks-module mods (built and tested on 2.1.321).
- Node.js on your `PATH`: the stats are counted by a small script, `scripts/stats.mjs`.

## Install

At the prompt of a terminal session:

```
/plugin install usage-card --marketplace RpYTMc/usage-card
```

From a shell:

```
claude plugin install usage-card --marketplace RpYTMc/usage-card
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `RpYTMc/usage-card`, then Add plugin.

## How the numbers are counted

Everything is read from the transcripts Claude Code already keeps on your computer (`~/.claude/projects`, or `CLAUDE_CONFIG_DIR/projects`). Nothing is sent anywhere.

- **Sessions:** top-level chats with at least one prompt, counted on the day of their first message.
- **Messages:** your prompts plus Claude's replies in those chats.
- **Total tokens:** input, output, cache writes and cache reads of every reply, subagents included.
- **Active days, peak hour, heatmap:** in your computer's local time.
- **Favorite model:** the model with the most tokens in the range.

The first count reads every transcript and can take some seconds. Each file's result is cached in `~/.claude/state/usage-card-stats.json`, so later counts only read the chats that changed.

## Development

```
claude plugin validate .
claude plugin test .
```

## Credits

Built with the help of Claude (Anthropic).

## License

MIT
