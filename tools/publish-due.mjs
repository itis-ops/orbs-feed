#!/usr/bin/env node
/**
 * publish-due.mjs — publishes any due+pending posts from queue.json to Instagram
 * via the Meta Graph API. Designed to run on a GitHub Actions cron (every 30 min)
 * but also runnable locally for dry-runs.
 *
 * Flow per due item:
 *   1. POST /{IG_USER_ID}/media   (image_url + caption)  -> creation_id
 *   2. poll  /{creation_id}?fields=status_code until FINISHED
 *   3. POST /{IG_USER_ID}/media_publish (creation_id)    -> media_id
 *   4. POST /{media_id}/comments (hashtags)              -> first comment
 *   5. mark item posted, persist queue.json (idempotent — never re-posts)
 *
 * Env:
 *   IG_USER_ID            (required to publish)
 *   IG_ACCESS_TOKEN       (required to publish)
 *   GRAPH_API_VERSION     (optional, default v21.0)
 *
 * Flags:
 *   --dry-run             log what would post; no API calls, no state change
 *   --queue <path>        queue file (default ./queue.json)
 *   --now <ISO>           override "current time" (testing)
 *   --limit <n>           max posts this run (default 3)
 *   --id <id>             force-publish a single item by id even if not yet due
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v21.0";
// Set GRAPH_BASE=https://graph.instagram.com for Instagram Login API tokens (IGA...).
// Version is appended automatically.
const GRAPH = process.env.GRAPH_BASE
  ? `${process.env.GRAPH_BASE.replace(/\/$/, "")}/${GRAPH_VERSION}`
  : `https://graph.facebook.com/${GRAPH_VERSION}`;

function parseArgs(argv) {
  const a = { dryRun: false, queue: path.join(REPO_ROOT, "queue.json"), now: null, limit: 3, id: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--queue") a.queue = path.resolve(argv[++i]);
    else if (k === "--now") a.now = argv[++i];
    else if (k === "--limit") a.limit = Number(argv[++i]);
    else if (k === "--id") a.id = argv[++i];
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reset items stuck in "posting" (crashed mid-run) back to pending. */
const STALE_POSTING_MS = 45 * 60 * 1000;

function recoverStalePosting(items, nowMs) {
  let n = 0;
  for (const it of items) {
    if (it.status !== "posting") continue;
    const claimedAt = Date.parse(it.claimedAt || 0);
    if (!claimedAt || nowMs - claimedAt > STALE_POSTING_MS) {
      it.status = "pending";
      delete it.claimedAt;
      delete it.claimedBy;
      n++;
    }
  }
  return n;
}

async function graphPost(url, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(url, { method: "POST", body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    throw new Error(`Graph POST ${res.status}: ${msg}`);
  }
  return json;
}

async function graphGet(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    throw new Error(`Graph GET ${res.status}: ${msg}`);
  }
  return json;
}

async function waitForContainer(creationId, token, { tries = 10, delayMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const status = await graphGet(
      `${GRAPH}/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
    );
    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new Error(`Container ${creationId} status ${status.status_code}: ${status.status || ""}`);
    }
    await sleep(delayMs);
  }
  throw new Error(`Container ${creationId} not ready after ${tries} checks`);
}

async function publishItem(item, { igUserId, token }) {
  const container = await graphPost(`${GRAPH}/${igUserId}/media`, {
    image_url: item.imageUrl,
    caption: item.caption || "",
    access_token: token,
  });
  const creationId = container.id;

  await waitForContainer(creationId, token);

  const published = await graphPost(`${GRAPH}/${igUserId}/media_publish`, {
    creation_id: creationId,
    access_token: token,
  });
  const mediaId = published.id;

  let commentId = null;
  if (item.firstComment && item.firstComment.trim()) {
    try {
      const comment = await graphPost(`${GRAPH}/${mediaId}/comments`, {
        message: item.firstComment,
        access_token: token,
      });
      commentId = comment.id;
    } catch (err) {
      console.warn(`  ! first comment failed (post still published): ${err.message}`);
    }
  }
  return { mediaId, commentId };
}

async function main() {
  const args = parseArgs(process.argv);
  const nowMs = args.now ? Date.parse(args.now) : Date.now();

  let raw = await fs.readFile(args.queue, "utf8");
  let queue = JSON.parse(raw);
  let items = queue.items || [];

  const igUserId = process.env.IG_USER_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  const publisher = process.env.ORBS_PUBLISHER || "unknown";

  const stale = recoverStalePosting(items, nowMs);
  if (stale > 0 && !args.dryRun) {
    await fs.writeFile(args.queue, JSON.stringify(queue, null, 2) + "\n", "utf8");
    console.log(`Recovered ${stale} stale posting claim(s).`);
  }

  const due = items.filter((it) => {
    if (it.status !== "pending") return false;
    if (args.id) return it.id === args.id;
    return Date.parse(it.scheduledAt) <= nowMs;
  });

  if (due.length === 0) {
    console.log("Nothing due. (pending:", items.filter((i) => i.status === "pending").length, ")");
    return;
  }

  console.log(`${due.length} due${args.dryRun ? " (DRY RUN)" : ""}. Graph ${GRAPH_VERSION}. limit=${args.limit}`);

  if (!args.dryRun && (!igUserId || !token)) {
    console.error("Missing IG_USER_ID / IG_ACCESS_TOKEN env. Cannot publish.");
    process.exit(1);
  }

  let posted = 0;
  let changed = false;
  for (const item of due) {
    if (posted >= args.limit) {
      console.log(`Hit limit ${args.limit}; remaining due items wait for next run.`);
      break;
    }
    const when = new Date(item.scheduledAt).toISOString();
    const localImg = path.join(REPO_ROOT, "posts", `${item.id}.jpg`);
    try {
      await fs.access(localImg);
    } catch {
      console.warn(`SKIP ${item.id}: posts/${item.id}.jpg not in repo yet (still pending)`);
      continue;
    }
    if (args.dryRun) {
      console.log(`WOULD POST  ${item.id}  @${when}`);
      console.log(`            img: ${item.imageUrl}`);
      console.log(`            cap: ${(item.caption || "").split("\n")[0].slice(0, 60)}...`);
      if (item.needsManualPin) console.log(`            (flag) pin 988 comment manually after posting`);
      posted++;
      continue;
    }

    try {
      // Re-read queue so a concurrent publisher's claim is visible before we post.
      raw = await fs.readFile(args.queue, "utf8");
      queue = JSON.parse(raw);
      items = queue.items || [];
      const live = items.find((it) => it.id === item.id);
      if (!live || live.status !== "pending") {
        console.log(`SKIP ${item.id}: no longer pending (${live?.status || "missing"})`);
        continue;
      }

      live.status = "posting";
      live.claimedAt = new Date().toISOString();
      live.claimedBy = publisher;
      await fs.writeFile(args.queue, JSON.stringify(queue, null, 2) + "\n", "utf8");

      console.log(`POSTING     ${live.id}  @${when}`);
      const { mediaId, commentId } = await publishItem(live, { igUserId, token });
      live.status = "posted";
      live.postedAt = new Date().toISOString();
      live.mediaId = mediaId;
      delete live.claimedAt;
      delete live.claimedBy;
      if (commentId) live.commentId = commentId;
      changed = true;
      posted++;
      console.log(`  ok -> media ${mediaId}${commentId ? `, comment ${commentId}` : ""}`);
      if (live.needsManualPin) {
        console.log(`  ACTION: open IG and PIN the resource comment on this post.`);
      }
      // persist immediately so a mid-run failure never double-posts earlier items
      await fs.writeFile(args.queue, JSON.stringify(queue, null, 2) + "\n", "utf8");
    } catch (err) {
      raw = await fs.readFile(args.queue, "utf8");
      queue = JSON.parse(raw);
      items = queue.items || [];
      const live = items.find((it) => it.id === item.id);
      if (live) {
        live.status = "error";
        live.error = err.message;
        live.erroredAt = new Date().toISOString();
        delete live.claimedAt;
        delete live.claimedBy;
      }
      changed = true;
      console.error(`  FAILED ${item.id}: ${err.message}`);
      await fs.writeFile(args.queue, JSON.stringify(queue, null, 2) + "\n", "utf8");
    }
  }

  if (changed && args.dryRun) {
    // never write in dry run
  }
  console.log(`Done. posted=${posted}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
