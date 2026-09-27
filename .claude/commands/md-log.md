---
description: Link a markdown file to mirror this teaching session into (for Obsidian).
argument-hint: <path-to-markdown-file>
allowed-tools: Bash(node .claude/hooks/md-log.mjs:*)
---

!`node .claude/hooks/md-log.mjs link "$ARGUMENTS"`

Tell the user the session is now mirrored to that file going forward (new turns only — this does not backfill earlier turns in this conversation).
