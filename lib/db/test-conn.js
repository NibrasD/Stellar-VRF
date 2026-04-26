import { Client } from "pg";

(async () => {
  try {
    console.log('DATABASE_URL raw:', JSON.stringify(process.env.DATABASE_URL));
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const res = await client.query('select now()');
    console.log('OK', res.rows);
    await client.end();
  } catch (e) {
    console.error('ERR', e);
    process.exit(1);
  }
})();
