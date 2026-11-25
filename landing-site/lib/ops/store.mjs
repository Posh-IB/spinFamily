// Storage boundary for the operations workspace.
// Production and previews use separate Netlify Blobs stores so test data never mixes with real records.
// Everything goes through this small interface so it can move to Postgres later without touching the API.

export function storeNameFor(deployContext) {
  return deployContext === 'production' ? 'sf-ops-v1-production' : 'sf-ops-v1-preview';
}

// Wraps a Netlify Blobs store.
export function blobAdapter(blobStore) {
  return {
    async get(key) { return (await blobStore.get(key, { type: 'json' })) ?? null; },
    async getWithEtag(key) {
      const r = await blobStore.getWithMetadata(key, { type: 'json' });
      return r ? { value: r.data, etag: r.etag } : null;
    },
    async set(key, value, opts = {}) {
      const r = await blobStore.setJSON(key, value, opts);
      return { modified: r?.modified !== false, etag: r?.etag };
    },
    async del(key) { await blobStore.delete(key); },
    async putFile(key, bytes, metadata) { await blobStore.set(key, bytes, { metadata }); },
    async getFile(key) {
      const r = await blobStore.getWithMetadata(key, { type: 'arrayBuffer' });
      return r ? { bytes: new Uint8Array(r.data), metadata: r.metadata } : null;
    },
    async list(prefix) {
      const keys = [];
      for await (const page of blobStore.list({ prefix, paginate: true })) for (const b of page.blobs) keys.push(b.key);
      return keys;
    },
  };
}

// In-memory implementation with the same semantics, used by tests.
export function memoryStore() {
  const m = new Map(); let n = 0;
  return {
    _map: m,
    async get(key) { return m.has(key) ? structuredClone(m.get(key).value) : null; },
    async getWithEtag(key) { return m.has(key) ? { value: structuredClone(m.get(key).value), etag: m.get(key).etag } : null; },
    async set(key, value, opts = {}) {
      if (opts.onlyIfNew && m.has(key)) return { modified: false };
      if (opts.onlyIfMatch && m.get(key)?.etag !== opts.onlyIfMatch) return { modified: false };
      const etag = `e${++n}`; m.set(key, { value: structuredClone(value), etag });
      return { modified: true, etag };
    },
    async del(key) { m.delete(key); },
    async putFile(key, bytes, metadata) { m.set(key, { value: { file: true }, bytes: new Uint8Array(bytes), metadata, etag: `e${++n}` }); },
    async getFile(key) { const e = m.get(key); return e?.bytes ? { bytes: e.bytes, metadata: e.metadata } : null; },
    async list(prefix) { return [...m.keys()].filter(k => k.startsWith(prefix)).sort(); },
  };
}

export async function getAll(store, prefix) {
  const keys = await store.list(prefix);
  const values = await Promise.all(keys.map(k => store.get(k)));
  return values.filter(Boolean);
}
