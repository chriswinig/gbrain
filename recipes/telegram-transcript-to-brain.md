---
id: telegram-transcript-to-brain
name: Telegram-Transcript-to-Brain
version: 0.9.1
description: Ingest Telegram chat transcripts from Hermes session files into compiled-truth + timeline brain pages with dedupe state.
category: sense
requires: []
secrets: []
health_checks:
  - "[ -f \"$HOME/.hermes/sessions/sessions.json\" ] && echo 'Hermes sessions index: OK' || echo 'Missing ~/.hermes/sessions/sessions.json'"
  - "[ -d \"$HOME/.hermes/sessions\" ] && echo 'Hermes sessions dir: OK' || echo 'Missing ~/.hermes/sessions'"
setup_time: 20 min
cost_estimate: "$0"
---

# Telegram-Transcript-to-Brain

Turn Telegram chat transcripts already captured by Hermes into durable brain pages.

This recipe is for cases like:
- a private founder/operator group
- a product team chat
- a client thread
- a recurring project room such as Lune Chat

It is intentionally stateful and incremental.

## What it reads

Hermes session artifacts:
- `~/.hermes/sessions/sessions.json` — session index with `origin.chat_id`, `user_id`, `user_name`
- `~/.hermes/sessions/<session_id>.jsonl` — append-only transcript
- optionally `session_<session_id>.json` snapshots for inspection/debugging

## What it writes

Compiled-truth + timeline brain pages, plus a state file such as:
- `~/.hermes/cron/state/<collector>.json`

The state file should track at minimum:
- `session_id`
- transcript hash
- line count
- processed_at
- last_timestamp

That lets the collector:
- skip already-processed sessions
- process only newly-added lines for still-open sessions
- avoid duplicating timeline entries on repeated runs

## Canonical pattern

1. Filter sessions by exact `origin.platform` + `origin.chat_id`
2. Map matching session IDs to transcript files
3. Compare against the state file
4. Read only new/changed transcripts
5. Extract durable signal only
6. Write/update compiled-truth + timeline pages
7. Run `gbrain put <slug> < <file>` after each touched page
8. Run `gbrain embed --stale` after each touched page or at the end of the batch
9. Update the state file only after successful page/index writes

## Good extraction buckets

Typical buckets for chat ingestion:
- product decisions
- user/client feedback
- action items
- content ideas
- feature discussions
- objections / constraints
- relationship signals

## Source attribution rule

Every timeline line must cite the source inline.

Recommended format:

`[Source: <speaker>, Telegram, <chat name>, <timestamp>, session <session_id>]`

Example:

`- Julia said the content should feel spontaneous and not scripted. [Source: Julia Zambuzzi, Telegram, Lune Chat, 2026-04-13 18:22 EDT, session 20260413_165504_92fe05cd]`

## When to use this recipe

Use this when:
- Hermes is already the chat runtime
- session capture already exists
- you want durable synthesis, not just raw archive
- you need incremental/deduped ingestion

Do not use this when:
- you need real-time chat mirroring message-by-message
- the chat platform does not already persist transcripts in Hermes
- you only need search across raw logs and not synthesized pages

## Operational notes

- Keep the cron after the day’s conversations, not in the middle of them
- Prefer 1–2 runs/day for synthesis, not every few minutes
- If the collector writes pages directly to markdown, always follow with `gbrain put` and `gbrain embed --stale`
- If the transcript source is noisy, bias toward under-extraction instead of storing chatter

## Example use case

Lune Chat collector:
- target chat: Telegram `-5199641784`
- reads Hermes session index to find Lune Chat session IDs
- writes pages under `projects/lune/`
- keeps dedupe state in `~/.hermes/cron/state/lune-chat-transcript-ingestion.json`
- runs twice daily so the nightly dream cycle sees already-structured pages

## Verification checklist

A correct installation should pass all of these:
- matching `chat_id` sessions are found from `sessions.json`
- only new/changed sessions are processed on the second run
- repeated runs do not duplicate timeline facts
- touched pages remain valid compiled-truth + timeline markdown
- `gbrain put` succeeds for every touched page
- `gbrain embed --stale` succeeds after updates
- the state file advances after success
