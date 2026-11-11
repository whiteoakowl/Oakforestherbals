'use strict';
// Re-encrypts every encrypted value and private file with the current CLINIC_ENCRYPTION_KEY, so an
// old key can be retired. Encrypted columns are found by name (every column ending in "_enc"),
// so new clinic tables are covered automatically. Work is done in small batches that fit inside a
// serverless request; the screen keeps calling until nothing is left.
const { get, all, run, tx } = require('./db');
const vault = require('./vault');
const storage = require('./storage');

async function encryptedColumns() {
  return all(`SELECT table_name AS t, column_name AS c FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name LIKE '%\\_enc' AND data_type = 'text' ORDER BY table_name, column_name`);
}

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Unexpected identifier ${s}`);
  return `"${s}"`;
};
const notCurrent = (c) => `${ident(c)} IS NOT NULL AND ${ident(c)} != '' AND ${ident(c)} NOT LIKE ?`;

async function status() {
  const kid = vault.currentKeyId();
  const columns = [];
  for (const { t, c } of await encryptedColumns()) {
    const row = await get(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE ${notCurrent(c)}) AS old FROM ${ident(t)} WHERE ${ident(c)} IS NOT NULL`, `v2:${kid}:%`);
    if (Number(row.n)) columns.push({ table: t, column: c, total: Number(row.n), old: Number(row.old) });
  }
  const files = await get("SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE key_id IS DISTINCT FROM ?) AS old, COUNT(*) FILTER (WHERE key_id = 'error') AS failed FROM patient_documents", kid);
  const oldValues = columns.reduce((s, x) => s + x.old, 0);
  return { keyId: kid, known: vault.knownKeyIds(), columns, oldValues, files: { total: Number(files.n), old: Number(files.old), failed: Number(files.failed) }, done: !oldValues && !Number(files.old) };
}

// Re-encrypts until the time budget runs out. Returns how many values and files were done.
async function runBatch({ budgetMs = 6000, batch = 100 } = {}) {
  const started = Date.now();
  const kid = vault.currentKeyId();
  const out = { values: 0, files: 0, errors: [] };
  for (const { t, c } of await encryptedColumns()) {
    for (;;) {
      if (Date.now() - started > budgetMs) return out;
      const rows = await all(`SELECT ctid::text AS ref, ${ident(c)} AS v FROM ${ident(t)} WHERE ${notCurrent(c)} LIMIT ?`, `v2:${kid}:%`, batch);
      if (!rows.length) break;
      let progressed = 0;
      await tx(async () => {
        // Lets the signed-note lock accept an update that changes nothing but the encryption.
        await get("SELECT set_config('app.reencrypt', 'on', true)");
        for (const r of rows) {
          let fresh;
          try { fresh = vault.seal(vault.open(r.v)); } catch (err) { out.errors.push(`${t}.${c}: ${err.message}`); continue; }
          const res = await run(`UPDATE ${ident(t)} SET ${ident(c)} = ? WHERE ctid = ?::tid AND ${ident(c)} = ?`, fresh, r.ref, r.v);
          if (res.changes) { out.values++; progressed++; }
        }
      });
      if (!progressed) break; // only undecryptable values remain in this column
    }
  }
  for (;;) {
    if (Date.now() - started > budgetMs) return out;
    const docs = await all("SELECT id, storage_key FROM patient_documents WHERE key_id IS DISTINCT FROM ? AND key_id IS DISTINCT FROM 'error' ORDER BY id LIMIT 5", kid);
    if (!docs.length) break;
    for (const d of docs) {
      try {
        const sealed = await storage.readPrivate(d.storage_key);
        if (vault.bufferKeyId(sealed) !== kid) await storage.savePrivate(d.storage_key, vault.sealBuffer(vault.openBuffer(sealed)), { overwrite: true });
        await run('UPDATE patient_documents SET key_id = ? WHERE id = ?', kid, d.id);
        out.files++;
      } catch (err) {
        out.errors.push(`document ${d.id}: ${err.message}`);
        await run("UPDATE patient_documents SET key_id = 'error' WHERE id = ? AND key_id IS DISTINCT FROM 'error'", d.id);
        if (out.errors.length > 20) return out;
      }
    }
  }
  return out;
}

module.exports = { encryptedColumns, status, runBatch };
