#!/usr/bin/env node
/**
 * refresh-secret.mjs — keeps IG_ACCESS_TOKEN fresh with zero human effort.
 *
 * Facebook long-lived tokens (~60 days) can be re-exchanged for a new
 * long-lived token while still valid. Running this on a monthly cron rolls the
 * expiry forward indefinitely, so the publisher never goes dark.
 *
 * Flow:
 *   1. fb_exchange_token(current IG_ACCESS_TOKEN) -> fresh ~60-day token
 *   2. gh secret set IG_ACCESS_TOKEN <fresh>   (uses GH_TOKEN = a PAT)
 *
 * Env (all from GitHub Actions secrets):
 *   IG_ACCESS_TOKEN   current long-lived token (the one to refresh)
 *   META_APP_ID       Meta app id
 *   META_APP_SECRET   Meta app secret
 *   GH_TOKEN          PAT with `repo` scope (so `gh secret set` can write)
 *   GH_REPO           owner/repo to update (default itis-ops/orbs-feed)
 *   GRAPH_API_VERSION optional (default v21.0)
 *
 * Safe by design: if any required secret is missing it logs and exits 0 so the
 * scheduled job never shows a red X just because auto-refresh isn't wired yet.
 */
import { spawnSync } from "node:child_process";

const VERSION = process.env.GRAPH_API_VERSION || "v21.0";
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const REPO = process.env.GH_REPO || "itis-ops/orbs-feed";

const token = process.env.IG_ACCESS_TOKEN;
const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;

function skip(msg) {
  console.log(`auto-refresh skipped: ${msg}`);
  process.exit(0);
}

if (!token) skip("no IG_ACCESS_TOKEN set");
if (!appId || !appSecret) skip("META_APP_ID / META_APP_SECRET not set");
if (!process.env.GH_TOKEN) skip("no GH_TOKEN (PAT) set — cannot write the secret");

async function getJson(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `${res.status} ${res.statusText}`);
  return json;
}

async function main() {
  console.log(`Graph ${VERSION}: re-exchanging current token for a fresh long-lived one...`);
  const exch = await getJson(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&fb_exchange_token=${encodeURIComponent(token)}`,
  );
  const fresh = exch.access_token;
  if (!fresh) throw new Error("no access_token in exchange response");
  const days = exch.expires_in ? Math.round(exch.expires_in / 86400) : null;
  console.log(`  got fresh token${days ? ` (~${days} days)` : ""}`);

  if (fresh === token) {
    console.log("  token unchanged (still fresh); nothing to update.");
    return;
  }

  const r = spawnSync(
    "gh",
    ["secret", "set", "IG_ACCESS_TOKEN", "--repo", REPO, "--body", fresh],
    { stdio: ["ignore", "inherit", "inherit"], env: process.env },
  );
  if (r.status !== 0) throw new Error("gh secret set failed (is GH_TOKEN a PAT with repo scope?)");
  console.log(`  IG_ACCESS_TOKEN secret updated on ${REPO}.`);
}

main().catch((err) => {
  console.error(`auto-refresh FAILED: ${err.message}`);
  process.exit(1);
});
