import express from "express";
import pg from "pg";
import "dotenv/config";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();

// GET /feed?sort=virality|credibility&status=corroborated&limit=50
app.get("/feed", async (req, res) => {
  const sort = req.query.sort === "credibility" ? "credibility_score" : "virality_score";
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const statusFilter = req.query.status;

  const params = [];
  let where = "";
  if (statusFilter) {
    params.push(statusFilter);
    where = `WHERE sc.status = $${params.length}`;
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT
       i.id, i.title, i.body, i.permalink, i.posted_at,
       i.upvotes, i.comment_count,
       s.platform, s.handle, s.trust_score,
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`leak-radar API listening on :${port}`));
