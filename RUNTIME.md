# Personal GBrain runtime note

This tree is Chris's custom personal GBrain skillpack/source tree. It is intentionally **not** the clean upstream source checkout.

Live CLI path:
- `/root/.local/bin/gbrain` → `/usr/local/bin/gbrain` wrapper
- wrapper sets `HOME=/opt/gbrain-home`, loads `/opt/gbrain-postgres/.env` + `/opt/gbrain-home/openai.env`, then executes `/opt/gbrain/bin/gbrain`

Current maintenance pattern:
- Keep this custom tree on the Chris-controlled branch for personal skillpack files.
- Keep clean upstream source/build mirror at `/opt/gbrain-src-upstream`.
- To upgrade without forcing unrelated-history/source drift: build upstream in `/opt/gbrain-src-upstream`, back up `/opt/gbrain/bin/gbrain`, replace only the compiled binary, run migrations, restart supervisor, then verify `gbrain doctor --fast`.

Do not force-switch this worktree to `origin/master` during routine maintenance.
