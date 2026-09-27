# learn

[![video](assets/thumbnail.png)](https://www.youtube.com/watch?v=kzcI5F4tGiU)

My AI learning system from this video: [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU).

This is a personal system I built for myself, shared as-is. Originally built as a pi configuration: the teaching philosophy encoded in a skill, a few small extensions, and agent definitions. It now also runs on **Claude Code**, side by side with the original Pi config — nothing under `agents/`, `extensions/`, `skills/` changed, so it keeps working as a `.pi` directory unmodified.

## What's in it

Pi (original):
- `skills/teach/` — the philosophy and the process
- `skills/visualize/` — adds a correct, minimal diagram to a lesson when an idea is clearer as a picture
- `extensions/ask-user-question/` — the agent asks you questions through a UI popup
- `extensions/quiz/` — graded questions with instant feedback (✓/✗, correct answer, explanation)
- `extensions/md-log/` — link a markdown file to the session
- `extensions/visual-tools/` — tools for visualization subagents
- `agents/` — `researcher`, `svg-maker`, `mermaid-maker`: the subagents the system delegates to

Claude Code (added, same behavior):
- `.claude/skills/teach/`, `.claude/skills/visualize/` — the same two skills, ported
- `.claude/agents/` — the same three subagents, with Claude Code subagent frontmatter
- `mcp-servers/quiz-ask/` — MCP server pairing with the built-in `AskUserQuestion` tool to reproduce graded quiz questions
- `mcp-servers/visual-tools/` — MCP server exposing the Mermaid/SVG write/edit/render tools the maker subagents use
- `.claude/hooks/md-log.mjs`, `.claude/commands/md-log.md` / `md-unlog.md` — session mirroring to a markdown file, reimplemented on Claude Code's hooks
- `CLAUDE.md`, `.mcp.json`, `.claude/settings.json` — repo-root pointer file, MCP server registration, and hook wiring

## Install

### As a `.pi` directory

This repo **is** a `.pi` directory. From your learning project's root:

```bash
git clone https://github.com/amosblomqvist/learn .pi
```

Then open pi in that directory. (Or copy the pieces you want into your existing project config.)

### With Claude Code

1. Install each MCP server's dependencies once:
   ```bash
   npm install --prefix mcp-servers/quiz-ask
   npm install --prefix mcp-servers/visual-tools
   ```
2. Either work directly at this repo's root, or copy `.claude/`, `CLAUDE.md`, `.mcp.json`, and `mcp-servers/` into an existing project.
3. Run `claude` in that directory. Check `/mcp` shows `learn-quiz-ask` and `learn-visual-tools` connected.

## Requirements

For Pi:
- [pi](https://github.com/earendil-works/pi)
- A subagent implementation, so the system can spawn the researcher and the visual makers. Recommended: [pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) (tmux only). With it, everything works out of the box. Any other implementation works too, but expect to adapt the agent definitions, e.g. `agents/researcher.md` lists `safe_bash` in its tools, which is specific to that extension.
- `ask-user-question` — use the copy bundled here. If your setup already has an `ask-user-question` extension, use **this** one in its place. Popups from different extensions serialize through a shared UI lock, which only works when it's the same implementation.

For Claude Code:
- [Claude Code](https://claude.com/claude-code)
- Node.js ≥ 20 (to run the two MCP servers via `npx tsx`)
- Mermaid rendering: a Chrome or Chromium install (used headless via `@mermaid-js/mermaid-cli`)
- SVG rendering: ImageMagick (`magick` on `PATH`) — the primary path on Windows, where `rsvg-convert` is uncommon. `rsvg-convert` (librsvg) is used as a fallback if present, and is the more common default on macOS/Linux.

## Notes

You can run the system without subagents. The main session does the teaching. You just lose the researcher (truth verification) and the generated visuals.

The teaching skill is written for one learner (me). Edit the skill to fit how you learn best.

Under Claude Code, the graded-quiz UX is necessarily different from Pi's TUI popup: `AskUserQuestion` caps options at 4 total (one of which is reserved for an automatic "I don't know"), always adds its own "Other" free-text slot, and grading feedback is relayed by the model in its chat reply rather than drawn as an inline ✓/✗ panel.

`md-log` is ported as a Claude Code hook, with one deliberate difference from the Pi version: linking with `/md-log <path>` does not backfill earlier turns in the conversation — mirroring starts from that point forward. See [`HOW_TO_USE.md`](HOW_TO_USE.md) for the day-to-day usage guide, including this feature.
