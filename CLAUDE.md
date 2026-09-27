# learn

This is a personal AI-learning system: a teaching philosophy, graded quiz/question
tooling, and diagram-making subagents. Full behavior lives in Skills, not here —
this file is intentionally thin so the teaching philosophy is only loaded when
it's actually relevant.

- `.claude/skills/teach/` — the teaching process. Loads automatically when you're
  explaining or teaching something.
- `.claude/skills/visualize/` — adds a correct diagram to a lesson when a picture
  earns its place.
- `.claude/agents/` — `researcher`, `mermaid-maker`, `svg-maker` subagents used by
  the skills above.
- `mcp-servers/` — two MCP servers registered in `.mcp.json`: `learn-quiz-ask`
  (graded quiz questions, paired with the built-in AskUserQuestion tool) and
  `learn-visual-tools` (Mermaid/SVG authoring + rendering tools for the maker
  subagents).
- `.claude/hooks/md-log.mjs` — mirrors the session to a linked markdown file,
  wired via `.claude/settings.json` hooks and the `/md-log`/`/md-unlog` commands.
