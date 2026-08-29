import pg from "pg";
import "dotenv/config";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Sample data so you can see the full pipeline (items -> scores -> API -> frontend)
// working today, without waiting on Reddit approval or any other live source.
// Safe to run multiple times — uses ON CONFLICT DO NOTHING.
const SAMPLE_ITEMS = [
  {
    platform: "seed",
    external_id: "seed-1",
    source_handle: "gta_insider_23",
    title: "Datamine reportedly shows new map region files",
    body: "Files referencing an unreleased area were allegedly found in a recent update package.",
    url: "https://example.com/leak-1",
    upvotes: 1240,
    comment_count: 380,
    hours_ago: 3,
    source_trust: 62,
  },
  {
    platform: "seed",
    external_id: "seed-2",
    source_handle: "rockstar_watcher",
    title: "Insider claims release window pushed back",
    body: "A source close to the studio says internal timelines have shifted.",
    url: "https://example.com/leak-2",
    upvotes: 890,
    comment_count: 210,
    hours_ago: 8,
    source_trust: 71,
  },
  {
    platform: "seed",
    external_id: "seed-3",
    source_handle: "random_throwaway99",
    title: "My cousin works at Rockstar and told me everything",
    body: "Unverified claims about story content, take with heavy skepticism.",
    url: "https://example.com/leak-3",
    upvotes: 45,
    comment_count: 12,
    hours_ago: 20,
    source_trust: 15,
  },
  {
    platform: "seed",
    external_id: "seed-4",
    source_handle: "gta_insider_23",
    title: "Beta build screenshots allegedly circulating in private servers",
    body: "Same source as the earlier map datamine post, images not yet public.",
    url: "https://example.com/leak-4",
    upvotes: 2100,
    comment_count: 640,
    hours_ago: 1,
    source_trust: 62,
  },
];

async function upsertSource(platform, handle, trustScore) {
  const res = await pool.query(
    `INSERT INTO sources (platform, handle, trust_score)
     VALUES ($1, $2, $3)
     ON CONFLICT (platform, handle) DO UPDATE SET trust_score = EXCLUDED.trust_score
     RETURNING id`,
    [platform, handle, trustScore]
  );
  return res.rows[0].id;
}

async function seed() {
  for (const item of SAMPLE_ITEMS) {
    const sourceId = await upsertSource(item.platform, item.source_handle, item.source_trust);
    const postedAt = new Date(Date.now() - item.hours_ago * 3600000).toISOString();

    await pool.query(
      `INSERT INTO items
         (platform, external_id, source_id, title, body, url, permalink, posted_at, upvotes, comment_count)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)
       ON CONFLICT (platform, external_id) DO UPDATE SET
         upvotes = EXCLUDED.upvotes,
         comment_count = EXCLUDED.comment_count`,
      [item.platform, item.external_id, sourceId, item.title, item.body, item.url, postedAt, item.upvotes, item.comment_count]
    );
  }
  console.log(`Seeded ${SAMPLE_ITEMS.length} sample items. Run "npm run score" next to compute their scores.`);
  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
