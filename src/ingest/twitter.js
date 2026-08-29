import pg from "pg";
import "dotenv/config";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TWITTERAPI_KEY = process.env.TWITTERAPI_IO_KEY;
const TWITTERAPI_BASE = "https://api.twitterapi.io";

// Advanced-search query — same syntax as x.com/search-advanced.
// Tune this to widen/narrow what counts as "leak-related" chatter.
// -filter:retweets keeps original posts only; min_faves filters out total noise.
const SEARCH_QUERY =
  process.env.TWITTER_SEARCH_QUERY ||
  '(GTA6 OR "GTA 6" OR "GTA VI") (leak OR leaked OR datamine OR insider OR unreleased) -filter:retweets min_faves:5';

async function upsertSource(handle, accountCreatedAt) {
  const res = await pool.query(
    `INSERT INTO sources (platform, handle, account_created_at)
     VALUES ('twitter', $1, $2)
     ON CONFLICT (platform, handle) DO UPDATE SET handle = EXCLUDED.handle
     RETURNING id`,
    [handle, accountCreatedAt]
  );
  return res.rows[0].id;
}

async function upsertItem(tweet, sourceId) {
  const permalink = `https://x.com/${tweet.author?.userName || "i"}/status/${tweet.id}`;
  const res = await pool.query(
    `INSERT INTO items
       (platform, external_id, source_id, title, body, url, permalink, posted_at, upvotes, comment_count)
     VALUES ('twitter', $1, $2, $3, $4, $5, $5, $6, $7, $8)
     ON CONFLICT (platform, external_id) DO UPDATE SET
       upvotes = EXCLUDED.upvotes,
       comment_count = EXCLUDED.comment_count
     RETURNING id`,
    [
      tweet.id,
      sourceId,
      (tweet.text || "").slice(0, 200),
      tweet.text || "",
      permalink,
      tweet.createdAt || new Date().toISOString(),
      tweet.likeCount || 0,
      tweet.replyCount || 0,
    ]
  );
  return res.rows[0].id;
}

async function searchTweets(cursor) {
  const url = new URL(`${TWITTERAPI_BASE}/twitter/tweet/advanced_search`);
  url.searchParams.set("query", SEARCH_QUERY);
  if (cursor) url.searchParams.set("cursor", cursor);

  const res = await fetch(url, {
    headers: { "X-API-Key": TWITTERAPI_KEY },
  });

  if (!res.ok) {
    throw new Error(`twitterapi.io request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function run() {
  if (!TWITTERAPI_KEY) {
    console.error("TWITTERAPI_IO_KEY is not set — skipping Twitter ingestion.");
    process.exit(1);
  }

  console.log(`Searching Twitter/X for: ${SEARCH_QUERY}`);
  const data = await searchTweets();
  const tweets = data.tweets || [];

  let matched = 0;
  for (const tweet of tweets) {
    const author = tweet.author || {};
    const sourceId = await upsertSource(
      author.userName || "unknown",
      author.createdAt ? new Date(author.createdAt) : null
    );
    await upsertItem(tweet, sourceId);
    matched++;
  }

  console.log(`Ingested ${matched} tweets.`);
  await pool.end();
}

run().catch((err) => {
  console.error("Twitter ingestion failed:", err);
  process.exit(1);
});
