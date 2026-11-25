// File storage for Company docs (Netlify Blobs). Production uses a site-wide store;
// every preview deploy gets its own deploy-scoped store, so previews never touch production files (IR-02).
import { getStore, getDeployStore } from '@netlify/blobs';

export function filesFor(isProduction) {
  const store = isProduction ? getStore({ name: 'sf-ops-files-v1', consistency: 'strong' }) : getDeployStore({ name: 'sf-ops-files-preview' });
  return blobFiles(store);
}
export function blobFiles(store) {
  return {
    async put(key, bytes, metadata) { await store.set(key, bytes, { metadata }); },
    async get(key) {
      const r = await store.getWithMetadata(key, { type: 'arrayBuffer' });
      return r ? { bytes: new Uint8Array(r.data), metadata: r.metadata } : null;
    },
  };
}
export function memoryFiles() {
  const m = new Map();
  return { _map: m, async put(key, bytes, metadata) { m.set(key, { bytes: new Uint8Array(bytes), metadata }); }, async get(key) { return m.get(key) || null; } };
}
