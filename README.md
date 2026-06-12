# orbs-feed

Public host for the Orbs Instagram feed. Contains **only** the composed post images and the publishing queue — the journals, safety codex, voice/style sources, and reference art stay private in the main `orbs` project.

## How it works

```
build-queue.mjs (private orbs project)
    └─ copies final JPEGs into posts/  +  writes queue.json
                    │
                    ▼
.github/workflows/publish.yml  (cron every 30 min)
    └─ runs tools/publish-due.mjs
            └─ Meta Graph API: create container → publish → first comment
            └─ marks item "posted" in queue.json and commits state back
```

## Contents

- `posts/*.jpg` — Instagram-ready 1080×1350 images, served via `raw.githubusercontent.com`
- `queue.json` — schedule + captions + per-item status (`pending` → `posted` / `error`)
- `tools/publish-due.mjs` — the publisher (native Node fetch, no deps)
- `.github/workflows/publish.yml` — scheduled runner + manual trigger

## Secrets (Actions → Settings → Secrets and variables)

| Secret | What |
| --- | --- |
| `IG_ACCESS_TOKEN` | Long-lived Meta token (~60 days) |
| `IG_USER_ID` | Instagram business account ID |

Optional repo **variable** `GRAPH_API_VERSION` (default `v21.0`).

See the main project's `SETUP-API.md` for how to obtain these.

## Manual controls

- Test without posting: **Actions → publish → Run workflow** with `dry_run = true`
- Local dry run: `IG_USER_ID=... IG_ACCESS_TOKEN=... node tools/publish-due.mjs --dry-run`
- Force one post now: `node tools/publish-due.mjs --id day-01-afternoon`

## Note on pinned comments

The Graph API can post the first (hashtag) comment but cannot **pin** comments. Night posts that carry the 988 resource line are flagged `needsManualPin` in the queue; pin them from the phone after they go live.
