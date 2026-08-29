import pg from "pg";
import "dotenv/config";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function clearSeed() {
  // scores rows cascade-delete automatically (ON DELETE CASCADE in schema.sql)
  const { rowCount } = await pool.query(`DELETE FROM items WHERE platform = 'seed'`);
  console.log(`Removed ${rowCount} seed item(s). Real ingested data is untouched.`);
  await pool.end();
}

clearSeed().catch((err) => {
  console.error("Failed to clear seed data:", err);
  process.exit(1);
});
