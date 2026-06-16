# orbs-feed

Public host for the Orbs Instagram feed. Contains **only** the composed post images and the publishing queue — the journals, safety codex, voice/style sources, and reference art stay private in the main `orbs` project.

## How it works

```
build-queue.mjs (private orbs project)
    └─ copies final JPEGs into posts/  +  writes queue.json
                    │
                    ▼
tools/local-publish.sh  (macOS launchd, every 15 min)  ← PRIMARY
    └─ runs tools/publish-due.mjs with creds from ../orbs/.env.local
            └─ Meta Graph API: create container → publish → first comment
            └─ marks item "posted" in queue.json and pushes state to GitHub

.github/workflows/publish.yml  (cloud backup when Mac is asleep)
    └─ same publish-due.mjs on GitHub Actions (~3 scheduled runs/day max)
```

## One-time scheduler setup (required)

GitHub Actions cron **does not** fire reliably on the free tier (~3×/day, often misses 10pm). The real scheduler is a macOS launchd job on your machine:

```bash
cd orbs-feed
bash tools/install-scheduler.sh
```

This runs `local-publish.sh` every 15 minutes. Due posts go out within 15 min of their scheduled time as long as your Mac is awake (or wakes within that window).

**Verify it's running:**

```bash
launchctl print gui/$(id -u)/com.orbs.publisher
tail -f /tmp/orbs-publish.log
```

**Requires:** `../orbs/.env.local` with `IG_USER_ID` and `IG_ACCESS_TOKEN`, and git push access to this repo.

## Contents

- `posts/*.jpg` — Instagram-ready 1080×1350 images, served via `raw.githubusercontent.com`
- `queue.json` — schedule + captions + per-item status (`pending` → `posted` / `error`)
- `tools/publish-due.mjs` — the publisher (native Node fetch, no deps)
- `tools/local-publish.sh` — primary scheduler entry point
- `tools/install-scheduler.sh` — installs the launchd job
- `.github/workflows/publish.yml` — cloud backup + manual trigger

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
- Run publisher once locally: `bash tools/local-publish.sh`
- Cloud backup trigger: `bash tools/trigger-publish.sh`

## Note on pinned comments

The Graph API can post the first (hashtag) comment but cannot **pin** comments. Night posts that carry the 988 resource line are flagged `needsManualPin` in the queue; pin them from the phone after they go live.
