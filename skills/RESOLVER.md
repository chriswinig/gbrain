# GBrain Skill Resolver

This is the top-level dispatcher for the personal GBrain skill pack. Read the referenced skill before acting.

## Routing

| Trigger | Skill |
|---|---|
| Ask/search/query brain knowledge | `skills/query/SKILL.md` |
| Ingest/import/save new material | `skills/ingest/SKILL.md` |
| Enrich people, companies, or pages | `skills/enrich/SKILL.md` |
| Maintain, doctor, embed, graph, dream cycle | `skills/maintain/SKILL.md` |
| Initial setup/configuration | `skills/setup/SKILL.md` |
| Migrate from other note systems | `skills/migrate/SKILL.md` |
| Publish/share brain pages | `skills/publish/SKILL.md` |
| Briefing or daily context | `skills/briefing/SKILL.md` |
| Install/update skill packs | `skills/install/SKILL.md` |

## Rules

- Prefer the most specific matching skill.
- Chain skills when a task spans ingest → enrich → maintain.
- For health checks, run the maintain flow.
