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

// --- Corroboration clustering (heuristic, no LLM call) ---
// Groups items from *different* sources whose titles share enough significant
// keywords to plausibly be describing the same claim, within a rolling time
// window. This is a text-similarity heuristic, not true fact-matching — it
// will miss paraphrased claims and can false-positive on generic overlapping
// terms (mitigated by requiring several shared *non-stopword* tokens, not just
// one). Good enough to surface likely corroboration for a human/algorithm to
// weigh, not a substitute for real verification.
const STOPWORDS = new Set([
  "the","a","an","and","or","but","is","are","was","were","be","been","of","to","in","on","for",
  "with","at","by","from","up","about","into","over","after","this","that","it","its","as","has",
  "have","had","will","just","not","new","gta","gta6","gta 6","vi","6","i","you","we","they","he","she",
]);

function significantTokens(title) {
  return new Set(
    (title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3 && !STOPWORDS.has(t))
  );
}

function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  const union = setA.size + setB.size - shared;
  return { similarity: union === 0 ? 0 : shared / union, shared };
}

const CLUSTER_WINDOW_HOURS = 72;
const MIN_SIMILARITY = 0.35;
const MIN_SHARED_TOKENS = 2;

async function runClaimClustering() {
  const { rows: items } = await pool.query(
    `SELECT id, title, source_id, posted_at
     FROM items
     WHERE posted_at > now() - interval '${CLUSTER_WINDOW_HOURS} hours'`
  );

  const tokenized = items.map((i) => ({ ...i, tokens: significantTokens(i.title) }));

  // itemId -> Set of matched itemIds (different source, similar enough title)
  const matches = new Map();
  for (let a = 0; a < tokenized.length; a++) {
    for (let b = a + 1; b < tokenized.length; b++) {
      const itemA = tokenized[a];
      const itemB = tokenized[b];
      if (!itemA.source_id || !itemB.source_id || itemA.source_id === itemB.source_id) continue;

      const { similarity, shared } = jaccard(itemA.tokens, itemB.tokens);
      if (similarity >= MIN_SIMILARITY && shared >= MIN_SHARED_TOKENS) {
        if (!matches.has(itemA.id)) matches.set(itemA.id, new Set());
        if (!matches.has(itemB.id)) matches.set(itemB.id, new Set());
        matches.get(itemA.id).add(itemB.id);
        matches.get(itemB.id).add(itemA.id);
      }
    }
  }

  console.log(`Claim clustering: ${matches.size} item(s) have at least one likely corroborating match.`);
  return matches; // itemId -> count of distinct corroborating items = matches.get(id).size
}

async function scoreAllItems() {
  const clusterMatches = await runClaimClustering();

  const { rows: items } = await pool.query(`
    SELECT
      i.id,
      i.upvotes,
      i.comment_count,
      i.posted_at,
      s.trust_score,
      s.account_created_at,
      COALESCE(sc.corroboration_count, 0) AS existing_corroboration_count
    FROM items i
    LEFT JOIN sources s ON s.id = i.source_id
    LEFT JOIN scores sc ON sc.item_id = i.id
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

    // Corroboration = the higher of (a) manual community votes already on
    // record, or (b) independent-source claim-cluster matches just computed.
    // We take the max rather than summing so clustering can't be gamed by
    // combining with vote-brigading, and manual votes aren't erased by a
    // clustering run that finds fewer matches than before.
    const clusterCount = clusterMatches.get(item.id)?.size ?? 0;
    const corroborationCount = Math.max(item.existing_corroboration_count, clusterCount);

    const credibility = computeCredibility({
      sourceTrust: item.trust_score ?? 50,
      accountAgeDays,
      corroborationCount,
    });

    const status = deriveStatus(credibility, corroborationCount);

    await pool.query(
      `INSERT INTO scores (item_id, credibility_score, virality_score, corroboration_count, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (item_id) DO UPDATE SET
         credibility_score = EXCLUDED.credibility_score,
         virality_score = EXCLUDED.virality_score,
         corroboration_count = EXCLUDED.corroboration_count,
         status = EXCLUDED.status,
         updated_at = now()`,
      [item.id, credibility, virality, corroborationCount, status]
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
