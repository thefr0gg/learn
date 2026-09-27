# learn

> This is a port of [amosblomqvist/learn](https://github.com/amosblomqvist/learn) from the [Pi](https://github.com/earendil-works/pi) agent harness to Claude Code.

My AI learning system from this video: [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU).

This is a personal system I built for myself, shared as-is. A Claude Code configuration: the teaching philosophy encoded in a skill, two MCP servers, a hook, and agent definitions.

## What's in it

- `.claude/skills/teach/` — the philosophy and the process
- `.claude/skills/visualize/` — adds a correct, minimal diagram to a lesson when an idea is clearer as a picture
- `.claude/agents/` — `researcher`, `svg-maker`, `mermaid-maker`: the subagents the system delegates to
- `mcp-servers/quiz-ask/` — MCP server pairing with the built-in `AskUserQuestion` tool for graded quiz questions, with instant feedback (✓/✗, correct answer, explanation)
- `mcp-servers/visual-tools/` — MCP server exposing the Mermaid/SVG write/edit/render tools the maker subagents use
- `.claude/hooks/md-log.mjs`, `.claude/commands/md-log.md` / `md-unlog.md` — link a markdown file to the session (e.g. for Obsidian)
- `CLAUDE.md`, `.mcp.json`, `.claude/settings.json` — repo-root pointer file, MCP server registration, and hook wiring

## Install

1. Install each MCP server's dependencies once:
   ```bash
   npm install --prefix mcp-servers/quiz-ask
   npm install --prefix mcp-servers/visual-tools
   ```
2. Either work directly at this repo's root, or copy `.claude/`, `CLAUDE.md`, `.mcp.json`, and `mcp-servers/` into an existing project.
3. Run `claude` in that directory. Check `/mcp` shows `learn-quiz-ask` and `learn-visual-tools` connected.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node.js ≥ 20 (to run the two MCP servers via `npx tsx`)
- Mermaid rendering: a Chrome or Chromium install (used headless via `@mermaid-js/mermaid-cli`)
- SVG rendering: ImageMagick (`magick` on `PATH`) — the primary path on Windows, where `rsvg-convert` is uncommon. `rsvg-convert` (librsvg) is used as a fallback if present, and is the more common default on macOS/Linux.

## Notes

You can run the system without subagents (skip the `Task`-based dispatch in the skills). You just lose the researcher (truth verification) and the generated visuals.

The teaching skill is written for one learner (me). Edit the skill to fit how you learn best.

The graded-quiz interaction is built on Claude Code's native `AskUserQuestion` tool: it caps options at 4 total (one of which is reserved for an automatic "I don't know"), always adds its own "Other" free-text slot, and grading feedback is relayed by the model in its chat reply rather than an inline ✓/✗ panel.

Linking with `/md-log <path>` does not backfill earlier turns in the conversation — mirroring starts from that point forward. See [`HOW_TO_USE.md`](HOW_TO_USE.md) for the day-to-day usage guide.
