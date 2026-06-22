# Shared GBrain quality conventions

Use this shared reference instead of repeating full rules in each skill.

## Filing and notability
- File by primary subject, not source format.
- Follow `skills/_brain-filing-rules.md` for directory routing, notability gates, raw source preservation, and back-link format.

## Back-linking
- Every mention of a person or company with a brain page needs a reverse link from that entity page back to the mentioning page.
- Missing back-links are graph-quality bugs.

## Citations
Every durable fact needs inline provenance:
- User/direct statement: `[Source: User, {context}, YYYY-MM-DD]`
- Meeting/email/message: `[Source: {channel/context}, YYYY-MM-DD]`
- Web/social/API: `[Source: {provider/publication}, {URL or handle}, YYYY-MM-DD]`
- Synthesis: `[Source: compiled from {sources}]`

## Source precedence
User direct statements > compiled truth > timeline/raw evidence > external sources.
When sources conflict, preserve the contradiction instead of silently choosing.
