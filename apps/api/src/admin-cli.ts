/**
 * Operator CLI, run on the box through SSM:
 *   docker compose exec api node dist/admin-cli.js <command> [args]
 * Talks to Postgres directly (no HTTP, no auth surface).
 */
import pg from 'pg';

try {
  process.loadEnvFile();
} catch {
  /* env comes from the container */
}

const [cmd, arg] = process.argv.slice(2);
const usage = `usage: admin-cli <command>
  stats                    counts of accounts, subdomains and captures
  disable-sub <slug>       delete a subdomain now (custom names get the 7-day tombstone)
  disable-account <email>  disable an account, delete its sessions/tokens and owned subdomains
  enable-account <email>   re-enable a disabled account
  find <slug|email>        show what we know about a subdomain or account`;

if (!cmd || cmd === 'help') {
  console.log(usage);
  process.exit(cmd ? 0 : 1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  switch (cmd) {
    case 'stats': {
      const r = await db.query(`SELECT
        (SELECT count(*) FROM account) AS accounts,
        (SELECT count(*) FROM subdomain) AS subdomains,
        (SELECT count(*) FROM subdomain WHERE owner_id IS NULL) AS anonymous,
        (SELECT count(*) FROM captured_request) AS captures`);
      console.table(r.rows);
      break;
    }
    case 'disable-sub': {
      if (!arg) throw new Error('slug required');
      await db.query('BEGIN');
      const s = await db.query('SELECT id, slug, is_custom, owner_id FROM subdomain WHERE slug = $1', [arg]);
      if (!s.rows[0]) throw new Error(`no such subdomain: ${arg}`);
      if (s.rows[0].is_custom)
        await db.query(
          `INSERT INTO slug_tombstone (slug, owner_id, until) VALUES ($1,$2, now() + interval '7 days')
           ON CONFLICT (slug) DO UPDATE SET until = EXCLUDED.until`,
          [arg, s.rows[0].owner_id],
        );
      await db.query('DELETE FROM subdomain WHERE id = $1', [s.rows[0].id]);
      await db.query('COMMIT');
      console.log(`deleted ${arg} (live tunnels drop within ~20s)`);
      break;
    }
    case 'disable-account': {
      if (!arg) throw new Error('email required');
      await db.query('BEGIN');
      const a = await db.query('UPDATE account SET disabled_at = now() WHERE lower(email) = lower($1) RETURNING id', [arg]);
      if (!a.rows[0]) throw new Error(`no such account: ${arg}`);
      const id = a.rows[0].id;
      await db.query('DELETE FROM session WHERE account_id = $1', [id]);
      await db.query('UPDATE cli_token SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL', [id]);
      const d = await db.query('DELETE FROM subdomain WHERE owner_id = $1', [id]);
      await db.query('COMMIT');
      console.log(`disabled ${arg}; revoked tokens and sessions; deleted ${d.rowCount} subdomain(s)`);
      break;
    }
    case 'enable-account': {
      if (!arg) throw new Error('email required');
      const a = await db.query('UPDATE account SET disabled_at = NULL WHERE lower(email) = lower($1) RETURNING id', [arg]);
      if (!a.rows[0]) throw new Error(`no such account: ${arg}`);
      console.log(`enabled ${arg}`);
      break;
    }
    case 'find': {
      if (!arg) throw new Error('slug or email required');
      const subs = await db.query(
        `SELECT s.slug, s.state, s.is_custom, s.owner_id, a.email AS owner_email, s.last_activity_at, s.hard_expires_at, s.created_at,
                (SELECT count(*) FROM captured_request c WHERE c.subdomain_id = s.id) AS captures
         FROM subdomain s LEFT JOIN account a ON a.id = s.owner_id WHERE s.slug = $1 OR lower(a.email) = lower($1)`,
        [arg],
      );
      console.table(subs.rows);
      const acct = await db.query('SELECT id, email, plan, created_at, disabled_at FROM account WHERE lower(email) = lower($1)', [arg]);
      if (acct.rows.length) console.table(acct.rows);
      break;
    }
    default:
      console.log(usage);
      process.exitCode = 1;
  }
} catch (e) {
  await db.query('ROLLBACK').catch(() => undefined);
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
