import pg from 'pg';
import fs from 'fs';

const connectionString = "postgresql://postgres.alfrthuahqssjqkqayra:hmChkdkU%5DrST@aws-1-eu-west-3.pooler.supabase.com:6543/postgres?sslmode=require";
const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  console.log("Connected to Supabase.");

  const sql = fs.readFileSync('c:/Users/User/Stellar-VRF/lib/db/drizzle/0000_short_lady_vermin.sql', 'utf-8');
  const statements = sql.split('--> statement-breakpoint').map(s => s.trim()).filter(s => s);

  for (const statement of statements) {
    try {
      await client.query(statement);
      console.log("Executed statement successfully.");
    } catch (e) {
      console.error("Error executing statement:", e.message);
    }
  }

  console.log("All done.");
  await client.end();
}

run().catch(console.error);
