import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log("Applying schema...");
  await client.query(schema);
  console.log("Schema applied successfully.");

  await client.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
