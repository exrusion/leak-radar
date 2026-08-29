# leak-radar

GTA leak aggregator for gtaleaks.fun. Scrapes leak-related chatter, scores it on
credibility and virality, serves a ranked feed via API.

## MVP scope (this version)

- **Ingestion:** Reddit only (r/GTA6, r/GTA, r/leaks, etc. — configurable)
- **Scoring:** credibility (source trust + account age + corroboration placeholder)
  and virality (engagement velocity)
- **API:** single `/feed` endpoint, sortable and filterable

Twitter and Discord ingestion, and real claim-clustering for corroboration, are
next steps — see "Not yet implemented" below.

## Setup

1. `cp .env.example .env` and fill in:
   - `DATABASE_URL` — Railway gives you this free when you add a Postgres plugin
   - Reddit API creds — create a "script" app at https://www.reddit.com/prefs/apps
2. `npm install`
3. `npm run migrate` — creates all tables
4. `npm run ingest` — pulls latest posts from configured subreddits, tags anything
   matching leak keywords, stores it
5. `npm run score` — computes credibility/virality for all stored items
6. `npm run serve` — starts the API on `PORT` (default 3000)

Then hit `GET /feed?sort=virality&limit=20` or `GET /feed?sort=credibility&status=corroborated`.

## Deploying (Railway, same pattern as your other projects)

- New Railway project → add Postgres plugin → it injects `DATABASE_URL` automatically
- Add this repo as a service, set the Reddit env vars
- Set up two cron-triggered services (or use Railway's cron schedule feature) for
  `npm run ingest` and `npm run score` — e.g. every 10-15 min
- Deploy `npm run serve` as the always-on web service

## How scoring actually works right now

**Virality** = engagement velocity. `(upvotes + comments*2) / hours_since_posted`,
compressed through a log curve so a post that goes from 0 to 5000 upvotes in an
hour doesn't just max out the scale and become indistinguishable from a post that
did the same over a week.

**Credibility** = weighted blend:
- 50% source trust score (starts neutral at 50 for every new author, you'll want
  to manually seed known reliable/unreliable accounts once you have real data)
- 20% account age (older Reddit accounts are harder to fake, caps out around 5yrs)
- 30% corroboration (same claim appearing from independent sources)

## Not yet implemented (next steps)

- **Twitter ingestion** — needs either a paid API (e.g. TwitterAPI.io) or a
  scraper; the DB schema already supports `platform = 'twitter'` so this is a
  new file in `src/ingest/`, not a schema change
- **Discord ingestion** — needs a bot token + being invited into target servers;
  flagged in the original spec as the most fragile source
- **Claim clustering** — the `claim_clusters` tables exist but nothing populates
  them yet. This is the biggest missing piece for real corroboration scoring —
  likely needs an LLM call (e.g. "are these two posts describing the same
  underlying claim?") run against new items vs. recent open clusters
- **Source trust score updates** — right now every source starts at 50 and
  never moves. Need a feedback loop: when a leak is later confirmed or debunked
  (manually curated, or via r/GTA6's own megathread consensus), bump/drop the
  trust score of everyone who posted about it
- **Frontend** — this repo is backend-only; pair with a Next.js feed UI (same
  pattern as your cashcow frontend on v0/Vercel)
