import express from "express";
import pg from "pg";
import crypto from "crypto";
import "dotenv/config";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json());

// Railway sits behind a proxy — trust it so req.ip reflects the real visitor IP
// rather than Railway's internal proxy address.
app.set("trust proxy", true);

// Never store raw IPs — hash with a server-side salt so votes can be deduped
// per-visitor without keeping identifying data.
const IP_SALT = process.env.IP_HASH_SALT || "leak-radar-default-salt-change-me";
function hashIp(ip) {
  return crypto.createHash("sha256").update(`${IP_SALT}:${ip}`).digest("hex");
}

// Allow the frontend (gtaleaks.fun, Vercel preview URLs, local dev) to call this API from the browser.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// GET /feed?sort=virality|credibility&status=corroborated&platform=community&limit=50
app.get("/feed", async (req, res) => {
  const sort = req.query.sort === "credibility" ? "credibility_score" : "virality_score";
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const statusFilter = req.query.status;
  const platformFilter = req.query.platform;

  const params = [];
  const conditions = [];
  if (statusFilter) {
    params.push(statusFilter);
    conditions.push(`sc.status = $${params.length}`);
  }
  if (platformFilter) {
    params.push(platformFilter);
    conditions.push(`i.platform = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT
       i.id, i.title, i.body, i.permalink, i.posted_at,
       i.upvotes, i.comment_count, i.platform,
       s.handle, s.trust_score,
       sc.credibility_score, sc.virality_score, sc.status, sc.corroboration_count
     FROM items i
     JOIN scores sc ON sc.item_id = i.id
     LEFT JOIN sources s ON s.id = i.source_id
     ${where}
     ORDER BY sc.${sort} DESC
     LIMIT $${params.length}`,
    params
  );

  res.json({ count: rows.length, items: rows });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// GET /sources — top sources ranked by trust score, for a real leaderboard.
// Deduplicated by handle (keeps the highest trust_score per handle).
app.get("/sources", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const { rows } = await pool.query(
    `SELECT platform, handle, trust_score, claims_confirmed, claims_debunked
     FROM (
       SELECT DISTINCT ON (handle) platform, handle, trust_score, claims_confirmed, claims_debunked
       FROM sources
       WHERE trust_score IS NOT NULL
       ORDER BY handle, trust_score DESC
     ) deduped
     ORDER BY trust_score DESC
     LIMIT $1`,
    [limit]
  );
  res.json({ count: rows.length, sources: rows });
});

// POST /items/:id/vote  { direction: "up" | "down" }
// One vote per (item, IP) — voting again just switches or no-ops instead of stacking.
app.post("/items/:id/vote", async (req, res) => {
  const itemId = parseInt(req.params.id);
  const direction = req.body?.direction;
  if (!itemId || (direction !== "up" && direction !== "down")) {
    return res.status(400).json({ error: "Expected { direction: 'up' | 'down' } and a valid item id" });
  }

  const ipHash = hashIp(req.ip);
  const delta = direction === "up" ? 1 : -1;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT direction FROM votes WHERE item_id = $1 AND ip_hash = $2`,
      [itemId, ipHash]
    );

    let scoreDelta = 0;
    if (existing.rows.length === 0) {
      // First vote from this visitor on this item.
      await client.query(
        `INSERT INTO votes (item_id, ip_hash, direction) VALUES ($1, $2, $3)`,
        [itemId, ipHash, direction]
      );
      scoreDelta = delta;
    } else if (existing.rows[0].direction === direction) {
      // Same vote again — no-op, they've already registered this vote.
      scoreDelta = 0;
    } else {
      // Switching from up to down (or vice versa) — undo the old, apply the new.
      await client.query(
        `UPDATE votes SET direction = $3, voted_at = now() WHERE item_id = $1 AND ip_hash = $2`,
        [itemId, ipHash, direction]
      );
      scoreDelta = delta * 2;
    }

    const result = await client.query(
      `UPDATE scores
       SET corroboration_count = GREATEST(0, corroboration_count + $1), updated_at = now()
       WHERE item_id = $2
       RETURNING item_id, corroboration_count, credibility_score, virality_score, status`,
      [scoreDelta, itemId]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }

    await client.query("COMMIT");
    res.json({ ...result.rows[0], your_vote: direction });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Vote failed:", err);
    res.status(500).json({ error: "Vote failed" });
  } finally {
    client.release();
  }
});

// POST /submissions  { url, description }
// Lets visitors submit a link (news post, tweet, video, etc.) with a short
// description. We store the link + description only — never the underlying
// media itself — so this stays a pointer/aggregator, not a file host.
app.post("/submissions", async (req, res) => {
  const url = (req.body?.url || "").trim();
  const description = (req.body?.description || "").trim();

  if (!url || !/^https?:\/\/.+/i.test(url)) {
    return res.status(400).json({ error: "A valid http(s) url is required" });
  }
  if (description.length > 500) {
    return res.status(400).json({ error: "description must be 500 characters or fewer" });
  }

  const ipHash = hashIp(req.ip);
  const sourceHandle = `community-${ipHash.slice(0, 8)}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sourceRes = await client.query(
      `INSERT INTO sources (platform, handle)
       VALUES ('community', $1)
       ON CONFLICT (platform, handle) DO UPDATE SET handle = EXCLUDED.handle
       RETURNING id`,
      [sourceHandle]
    );
    const sourceId = sourceRes.rows[0].id;

    const externalId = crypto.createHash("sha256").update(url).digest("hex").slice(0, 40);
    const title = description || url;

    const itemRes = await client.query(
      `INSERT INTO items
         (platform, external_id, source_id, title, body, url, permalink, posted_at, upvotes, comment_count)
       VALUES ('user_submitted', $1, $2, $3, $4, $5, $5, now(), 0, 0)
       ON CONFLICT (platform, external_id) DO NOTHING
       RETURNING id`,
      [externalId, sourceId, title.slice(0, 200), description, url]
    );

    if (itemRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This link has already been submitted" });
    }

    const itemId = itemRes.rows[0].id;
    await client.query(
      `INSERT INTO scores (item_id, credibility_score, virality_score, corroboration_count, status)
       VALUES ($1, 40, 0, 0, 'unverified')`,
      [itemId]
    );

    await client.query("COMMIT");
    res.status(201).json({ id: itemId, message: "Submitted for review" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Submission failed:", err);
    res.status(500).json({ error: "Submission failed" });
  } finally {
    client.release();
  }
});

// --- Admin moderation (protected by ADMIN_KEY) ---
// Send the key as header "x-admin-key". Never expose this key in the frontend
// or any public repo — it's meant for you (or a private admin tool) only.
const ADMIN_KEY = process.env.ADMIN_KEY;
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).json({ error: "Admin moderation is not configured (ADMIN_KEY not set)" });
  }
  if (req.header("x-admin-key") !== ADMIN_KEY) {
    return res.status(401).json({ error: "Invalid or missing x-admin-key header" });
  }
  next();
}

// GET /admin/queue — items awaiting review, oldest first.
// Defaults to unverified/community submissions since those need the most eyes,
// but any status can be requested via ?status=.
app.get("/admin/queue", requireAdmin, async (req, res) => {
  const statusFilter = req.query.status || "unverified";
  const { rows } = await pool.query(
    `SELECT
       i.id, i.title, i.body, i.permalink, i.posted_at, i.platform,
       s.id AS source_id, s.platform AS source_platform, s.handle, s.trust_score,
       sc.credibility_score, sc.virality_score, sc.status, sc.corroboration_count
     FROM items i
     JOIN scores sc ON sc.item_id = i.id
     LEFT JOIN sources s ON s.id = i.source_id
     WHERE sc.status = $1
     ORDER BY i.posted_at ASC
     LIMIT 100`,
    [statusFilter]
  );
  res.json({ count: rows.length, items: rows });
});

// POST /admin/moderate/:id  { action: "confirm" | "debunk" | "delete" }
// - confirm: marks the claim as verified true, rewards the source's trust score
// - debunk: marks it false, penalizes the source's trust score
// - delete: removes the item entirely (e.g. spam, abuse, off-topic)
app.post("/admin/moderate/:id", requireAdmin, async (req, res) => {
  const itemId = parseInt(req.params.id);
  const action = req.body?.action;
  if (!itemId || !["confirm", "debunk", "delete"].includes(action)) {
    return res.status(400).json({ error: "Expected { action: 'confirm' | 'debunk' | 'delete' } and a valid item id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const itemRes = await client.query(`SELECT source_id FROM items WHERE id = $1`, [itemId]);
    if (itemRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }
    const sourceId = itemRes.rows[0].source_id;

    if (action === "delete") {
      await client.query(`DELETE FROM items WHERE id = $1`, [itemId]);
      await client.query("COMMIT");
      return res.json({ id: itemId, action: "deleted" });
    }

    const newStatus = action === "confirm" ? "confirmed" : "debunked";
    await client.query(
      `UPDATE scores SET status = $1, updated_at = now() WHERE item_id = $2`,
      [newStatus, itemId]
    );

    if (sourceId) {
      if (action === "confirm") {
        await client.query(
          `UPDATE sources
           SET claims_confirmed = claims_confirmed + 1,
               trust_score = LEAST(100, trust_score + 10)
           WHERE id = $1`,
          [sourceId]
        );
      } else {
        await client.query(
          `UPDATE sources
           SET claims_debunked = claims_debunked + 1,
               trust_score = GREATEST(0, trust_score - 15)
           WHERE id = $1`,
          [sourceId]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ id: itemId, action: newStatus });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Moderation action failed:", err);
    res.status(500).json({ error: "Moderation action failed" });
  } finally {
    client.release();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`leak-radar API listening on :${port}`));
