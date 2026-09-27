# How to use this

This assumes you've already done the one-time setup in the README's "Install"
section: `npm install` in both `mcp-servers/*` directories, and either working
at this repo's root or having `.claude/`, `CLAUDE.md`, `.mcp.json`, and
`mcp-servers/` copied into your project.

## Starting a session

```bash
cd <your project root>   # wherever .claude/ and .mcp.json live
claude
```

Check the MCP servers connected before relying on quizzes or diagrams:

```
/mcp
```

You should see `learn-quiz-ask` and `learn-visual-tools` listed as connected. If
either shows an error, see Troubleshooting below.

## Just ask to be taught something

There's no special command — the `teach` skill triggers automatically whenever
you ask to be explained or taught something:

```
teach me how TCP works
explain what a Fourier transform is
I want to understand how neural networks learn
```

What happens next, in order:

1. **Probe.** The model asks a series of graded questions (each pops up as an
   interactive multiple-choice prompt) to find the edge of what you already
   know. Answer honestly — "I don't know" is always an option and is treated
   as a real, useful signal, not a wrong guess. It'll also ask at least one
   open-ended question (no right answer) about what you actually want to get
   out of the lesson.
2. **Plan.** It dispatches a `researcher` subagent in the background to
   double-check the topic, then presents a short plan in chat: the approach in
   prose, plus a small `mermaid` dependency-graph diagram of what it's going to
   teach and in what order. **It stops here and waits for you to say go.**
   Push back if a root looks wrong or the scope is off — that's the point of
   this checkpoint.
3. **Teach.** It walks the dependency graph one node at a time — motivate,
   establish, connect, quiz-check — pausing to verify each piece landed before
   building on it. Expect diagrams to show up inline when a picture genuinely
   carries the idea better than prose.

You can interrupt or redirect at any point; nothing here is a rigid script.

## The graded-quiz interaction

When a question has a right answer, you'll see Claude Code's native interactive
picker: arrow keys (or number keys) to pick an option, Enter to submit. Options
always include:

- The real answer choices (up to 3)
- **"I don't know"** — pick this if you genuinely don't know; it's graded as a
  knowledge gap, not a wrong guess
- **"Other"** — Claude Code always adds this as a free-text slot. If you type
  something here instead of picking a listed option, it's **not graded**
  right/wrong — treat it as a way to add a note or ask a question instead of
  answering.

Right after you answer, the model relays feedback in its next chat message:
whether you got it right, the correct answer, and an explanation.

## Getting a diagram

Usually you don't need to ask — the `teach` skill inserts one automatically
during planning (the dependency-graph overview) and during a lesson node when
a picture genuinely helps. You can also ask directly:

```
can you show me a diagram of how DNS resolution works
draw a number line showing where these values sit
```

Behind the scenes this dispatches a `mermaid-maker` or `svg-maker` subagent,
which writes the diagram source, renders it, **looks at the rendered image**,
iterates until it's correct, and publishes a PNG into `viz/` in your project
(pick a project that's an Obsidian vault, or just a folder, if you want to
actually view the images — the teaching skill was originally designed around
Obsidian's wikilink embeds).

## Mirroring the session to a markdown file (Obsidian)

If you want to read a lesson in something nicer than the terminal (LaTeX,
markdown, and embedded diagrams all render), link a markdown file:

```
/md-log path/to/notes/lesson.md
```

From that point on, new user prompts, assistant prose, and graded-quiz Q&A
blocks get appended to that file as the session continues. **This does not
backfill anything said before you ran `/md-log`** — only new turns are
mirrored. Point it at a file inside an Obsidian vault to get inline-rendered
diagrams and LaTeX for free.

Stop mirroring with:

```
/md-unlog
```

If nothing is showing up in the linked file, confirm the hooks are actually
registered (`.claude/settings.json` should list a `Stop` hook and a
`PostToolUse` hook matched on `mcp__learn-quiz-ask__grade_quiz` — check with
`/hooks` in-session), and that Node.js is on `PATH` (the hooks run
`node .claude/hooks/md-log.mjs ...`).

## Using the researcher directly

You don't normally need to invoke this yourself — the `teach` skill dispatches
it automatically during planning and whenever the model is unsure of a fact.
If you want a quick research brief on its own:

```
use the researcher subagent to look into <topic>
```

## Troubleshooting

**`/mcp` shows `learn-quiz-ask` or `learn-visual-tools` as disconnected/errored**
- Confirm you ran `npm install --prefix mcp-servers/quiz-ask` and
  `npm install --prefix mcp-servers/visual-tools` at least once.
- Confirm Node.js ≥ 20 is on `PATH` (`node --version`).
- `.mcp.json` uses relative paths (`mcp-servers/...`), so Claude Code needs to
  be started with that directory as the working directory / project root.

**Diagrams fail to render (`render_mermaid`/`render_svg` return an error, not an image)**
- Mermaid needs a Chrome or Chromium install on the machine — the server looks
  in the usual Windows/macOS/Linux install locations automatically.
- SVG rendering needs ImageMagick (`magick` on `PATH`) or, as a fallback,
  `rsvg-convert`. On Windows, install ImageMagick and make sure `magick` is on
  `PATH` (verify with `magick -version` in a terminal).
- The error text returned by the tool includes the actual stderr from the
  render command — read it, it usually says exactly what's missing.

**Quiz options look repetitive across a session, or a quiz seems to silently vanish**
- Each `prepare_quiz` call is graded exactly once and expires after an hour;
  if the model calls `grade_quiz` with a stale or already-used `quizId`, it'll
  get an explicit "unknown or expired quizId" error back and should just call
  `prepare_quiz` again rather than guessing.
