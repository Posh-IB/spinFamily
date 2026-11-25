import { getStore } from '@netlify/blobs';
import { ingestPilotSubmission } from '../../lib/ops/api.mjs';
import { blobAdapter, storeNameFor } from '../../lib/ops/store.mjs';

// Copies each new pilot-form registration into the operations workspace.
// Runs alongside pilot-welcome; it never sends email and never changes the welcome ledger.
export default {
  async formSubmitted(event) {
    const store = blobAdapter(getStore({ name: storeNameFor(process.env.CONTEXT === 'production' || !process.env.CONTEXT ? 'production' : 'preview'), consistency: 'strong' }));
    const state = await ingestPilotSubmission(store, event.data, new Date().toISOString());
    console.info(JSON.stringify({ component: 'ops-intake', state }));
  },
};
