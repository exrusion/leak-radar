import pg from "pg";
import "dotenv/config";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// --- Virality ---
// Based on engagement velocity: how fast upvotes/comments are accumulating
// relative to how long the item has been up. Recent, fast-moving items score higher.
function computeVirality({ upvotes, commentCount, hoursSincePosted }) {
  const age = Math.max(hoursSincePosted, 0.5); // avoid divide-by-zero for brand new posts
  const engagementRate = (upvotes + commentCount * 2) / age; // comments weighted higher than upvotes

  // Squash into 0-100 with a log curve so viral outliers don't blow out the scale
  const score = Math.min(100, Math.log10(engagementRate + 1) * 40);
  return Math.round(score * 10) / 10;
}

// --- Credibility ---
// Weighted blend of source trust, account age, and corroboration.
function computeCredibility({ sourceTrust, accountAgeDays, corroborationCount }) {
  const trustComponent = sourceTrust; // 0-100, already normalized
  const ageComponent = Math.min(100, (accountAgeDays / 365) * 20); // older accounts score up, caps around 5yrs
  const corroborationComponent = Math.min(100, corroborationCount * 25); // each independent corroborating source is worth a lot

  const score =
    trustComponent * 0.5 + ageComponent * 0.2 + corroborationComponent * 0.3;
  return Math.round(score * 10) / 10;
}

function deriveStatus(credibilityScore, corroborationCount) {
  if (credibilityScore >= 75 && corroborationCount >= 2) return "corroborated";
  if (credibilityScore < 25) return "low_credibility";
  return "unverified";
}

async function scoreAllItems() {
  const { rows: items } = await pool.query(`
    SELECT
      i.id,
      i.upvotes,
      i.comment_count,
      i.posted_at,
      s.trust_score,
      s.account_created_at,
      COALESCE(cc.corroboration_count, 0) AS corroboration_count
    FROM items i
    LEFT JOIN sources s ON s.id = i.source_id
    LEFT JOIN (
      SELECT cluster_id, COUNT(*) - 1 AS corroboration_count
      FROM claim_cluster_items
      GROUP BY cluster_id
    ) cc ON false -- corroboration join wired up once claim clustering is implemented (see notes below)
  `);

  console.log(`Scoring ${items.length} items...`);

  for (const item of items) {
    const hoursSincePosted = (Date.now() - new Date(item.posted_at).getTime()) / 3600000;
    const accountAgeDays = item.account_created_at
      ? (Date.now() - new Date(item.account_created_at).getTime()) / 86400000
      : 0;

    const virality = computeVirality({
      upvotes: item.upvotes,
      commentCount: item.comment_count,
      hoursSincePosted,
    });

    const credibility = computeCredibility({
      sourceTrust: item.trust_score ?? 50,
      accountAgeDays,
      corroborationCount: item.corroboration_count,
    });

    const status = deriveStatus(credibility, item.corroboration_count);

    await pool.query(
      `INSERT INTO scores (item_id, credibility_score, virality_score, corroboration_count, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (item_id) DO UPDATE SET
         credibility_score = EXCLUDED.credibility_score,
         virality_score = EXCLUDED.virality_score,
         corroboration_count = EXCLUDED.corroboration_count,
         status = EXCLUDED.status,
         updated_at = now()`,
      [item.id, credibility, virality, item.corroboration_count, status]
    );
  }

  console.log("Scoring run complete.");
}

scoreAllItems()
  .then(() => pool.end())
  .catch((err) => {
    console.error("Scoring failed:", err);
    process.exit(1);
  });
