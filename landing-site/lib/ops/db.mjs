// Postgres access for the operations workspace (R2-01..05).
// One small tagged-template client over any pg-compatible pool (node-postgres in tests,
// Netlify Database's pool in functions), plus real transactions on a single connection.
//
//   const db = makeDb(pool);
//   await db.sql`SELECT ... WHERE id = ${id}`          -> rows
//   await db.tx(async sql => { ...same API, one transaction... })
//
// Rules the handlers follow:
//   - Anything that must stay true across several statements runs inside db.tx and locks the
//     rows it depends on (SELECT ... FOR UPDATE) before checking them.
//   - Email is never sent inside a transaction; it goes to notifications_outbox and is sent
//     after commit (approvals, sharing) or right after commit (sign-in links).

function prep(v) {
  if (typeof v === 'bigint') return v.toString();
  if (v === undefined) return null;
  return v;
}

export function sqlFor(q, { inTx = false } = {}) {
  const tag = async (strings, ...values) => {
    let textOut = strings[0];
    for (let i = 1; i < strings.length; i++) textOut += `$${i}` + strings[i];
    const r = await q.query(textOut, values.map(prep));
    return r.rows;
  };
  tag.unsafe = async textOut => (await q.query(textOut)).rows;
  tag.inTx = inTx;
  return tag;
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock

export function makeDb(pool, { hook } = {}) {
  const sql = sqlFor(pool);
  async function tx(fn, { retries = 2 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const client = await pool.connect();
      let done = false;
      try {
        await client.query('BEGIN');
        const result = await fn(sqlFor(client, { inTx: true }));
        const c = await client.query('COMMIT');
        done = true;
        // Postgres answers COMMIT on an aborted transaction with ROLLBACK and no error. Never report that as saved.
        if (c?.command === 'ROLLBACK') { const e = new Error('transaction rolled back'); e.code = 'TX_ROLLED_BACK'; throw e; }
        return result;
      } catch (e) {
        if (!done) await client.query('ROLLBACK').catch(() => {});
        if (RETRYABLE.has(e?.code) && attempt < retries) continue;
        throw e;
      } finally {
        client.release();
      }
    }
  }
  return { sql, tx, pool, hook };
}

// Run fn with a copy of env/deps whose `sql` is the transaction, so existing helpers that
// read deps.sql become part of the same transaction without changing their signatures.
export function inTx(deps, fn, opts) {
  if (deps.sql?.inTx) return fn(deps); // already inside one
  return deps.tx(sql => fn({ ...deps, sql }), opts);
}

// Test-only pause points. In production deps.hook is undefined and this is a no-op.
export async function barrier(deps, name) {
  if (deps.hook) await deps.hook(name);
}
