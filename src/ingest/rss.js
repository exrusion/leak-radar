import Parser from "rss-parser";
import pg from "pg";
import "dotenv/config";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const parser = new Parser();

// RSS/Atom feeds to poll. No auth, no approval queue — these are public feeds.
// Mix of GTA news sites and YouTube channel upload feeds.
// YouTube channel feed format: https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID
// (find a channel_id via the channel's page source or a lookup tool)
const DEFAULT_FEEDS = [
  { url: "https://www.rockstargames.com/newswire.rss", label: "Rockstar Newswire" },
  { url: "https://www.gtaboom.com/feed/", label: "GTA BOOM" },
  { url: "https://www.gta6news.net/feed/", label: "GTA6 News" },
];

const FEEDS = process.env.RSS_FEEDS
  ? process.env.RSS_FEEDS.split(",").map((url) => ({ url: url.trim(), label: url.trim() }))
  : DEFAULT_FEEDS;

// Same leak-keyword filter as the Reddit worker, tuned for headline-style text.
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
  "rumor",
  "rumour",
];

function looksLeakRelated(title, summary) {
  const text = `${title} ${summary || ""}`.toLowerCase();
  return LEAK_KEYWORDS.some((kw) => text.includes(kw));
}

async function upsertSource(platform, handle) {
  const res = await pool.query(
    `INSERT INTO sources (platform, handle)
     VALUES ($1, $2)
     ON CONFLICT (platform, handle) DO UPDATE SET handle = EXCLUDED.handle
     RETURNING id`,
    [platform, handle]
  );
  return res.rows[0].id;
}

async function upsertItem(entry, sourceId, feedLabel) {
  const externalId = entry.guid || entry.link || `${feedLabel}-${entry.title}`;
  const postedAt = entry.isoDate || entry.pubDate || new Date().toISOString();

  const res = await pool.query(
    `INSERT INTO items
       (platform, external_id, source_id, title, body, url, permalink, posted_at, upvotes, comment_count)
     VALUES ('rss', $1, $2, $3, $4, $5, $5, $6, 0, 0)
     ON CONFLICT (platform, external_id) DO NOTHING
     RETURNING id`,
    [externalId, sourceId, entry.title, entry.contentSnippet || entry.content || "", entry.link, postedAt]
  );
  return res.rows[0]?.id ?? null;
}

async function ingestFeed({ url, label }) {
  console.log(`Fetching ${label} (${url})...`);
  let feed;
  try {
    feed = await parser.parseURL(url);
  } catch (err) {
    console.error(`  -> failed to parse feed: ${err.message}`);
    return;
  }

  const sourceId = await upsertSource("rss", label);

  let matched = 0;
  for (const entry of feed.items || []) {
    if (!looksLeakRelated(entry.title, entry.contentSnippet)) continue;
    const itemId = await upsertItem(entry, sourceId, label);
    if (itemId) matched++;
  }
  console.log(`  -> ${matched} new leak-related items from ${label}`);
}

async function run() {
  for (const feed of FEEDS) {
    await ingestFeed(feed);
  }
  await pool.end();
  console.log("RSS ingestion run complete.");
}

run();
