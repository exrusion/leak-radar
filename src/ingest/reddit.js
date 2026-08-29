import Snoowrap from "snoowrap";
import pg from "pg";
import "dotenv/config";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const reddit = new Snoowrap({
  userAgent: process.env.REDDIT_USER_AGENT,
  clientId: process.env.REDDIT_CLIENT_ID,
  clientSecret: process.env.REDDIT_CLIENT_SECRET,
  username: process.env.REDDIT_USERNAME,
  password: process.env.REDDIT_PASSWORD,
});

const SUBREDDITS = (process.env.REDDIT_SUBREDDITS || "GTA6,GTA,leaks")
  .split(",")
  .map((s) => s.trim());

// Keywords that suggest a post is leak-related, not just general discussion.
// Tune this list as you observe what actually shows up.
const LEAK_KEYWORDS = [
  "leak",
  "leaked",
  "datamine",
  "dataminer",
  "insider",
  "source says",
  "unreleased",
  "beta build",
  "internal build",
  "rockstar employee",
];

function looksLeakRelated(title, body) {
  const text = `${title} ${body || ""}`.toLowerCase();
  return LEAK_KEYWORDS.some((kw) => text.includes(kw));
}

async function upsertSource(platform, handle, accountCreatedAt) {
  const res = await pool.query(
    `INSERT INTO sources (platform, handle, account_created_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (platform, handle) DO UPDATE SET handle = EXCLUDED.handle
     RETURNING id`,
    [platform, handle, accountCreatedAt]
  );
  return res.rows[0].id;
}

async function upsertItem(item, sourceId) {
  const res = await pool.query(
    `INSERT INTO items
       (platform, external_id, source_id, title, body, url, permalink, posted_at, upvotes, comment_count)
     VALUES ('reddit', $1, $2, $3, $4, $5, $6, to_timestamp($7), $8, $9)
     ON CONFLICT (platform, external_id) DO UPDATE SET
       upvotes = EXCLUDED.upvotes,
       comment_count = EXCLUDED.comment_count
     RETURNING id`,
    [
      item.id,
      sourceId,
      item.title,
      item.selftext,
      item.url,
      `https://reddit.com${item.permalink}`,
      item.created_utc,
      item.ups,
      item.num_comments,
    ]
  );
  return res.rows[0].id;
}

async function snapshotEngagement(itemId, upvotes, commentCount) {
  await pool.query(
    `INSERT INTO engagement_snapshots (item_id, upvotes, comment_count) VALUES ($1, $2, $3)`,
    [itemId, upvotes, commentCount]
  );
}

async function ingestSubreddit(subredditName) {
  console.log(`Fetching r/${subredditName}...`);
  const posts = await reddit.getSubreddit(subredditName).getNew({ limit: 50 });

  let matched = 0;
  for (const post of posts) {
    if (!looksLeakRelated(post.title, post.selftext)) continue;
    matched++;

    const author = await post.author.fetch().catch(() => null);
    const sourceId = await upsertSource(
      "reddit",
      post.author.name,
      author ? new Date(author.created_utc * 1000) : null
    );

    const itemId = await upsertItem(post, sourceId);
    await snapshotEngagement(itemId, post.ups, post.num_comments);
  }
  console.log(`  -> ${matched}/${posts.length} posts matched leak keywords`);
}

async function run() {
  for (const sub of SUBREDDITS) {
    try {
      await ingestSubreddit(sub);
    } catch (err) {
      console.error(`Failed to ingest r/${sub}:`, err.message);
    }
  }
  await pool.end();
  console.log("Ingestion run complete.");
}

run();
