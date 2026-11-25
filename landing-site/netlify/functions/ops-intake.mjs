import { getDatabase } from '@netlify/database';
import { ingestPilotSubmission } from '../../lib/ops/records.mjs';
import { runtimeFacts, OPS_ORG } from '../../lib/ops/runtime.mjs';

// Copies each new pilot-form registration into the operations workspace.
// Runs alongside pilot-welcome; it never sends email and never touches the welcome ledger.
// Fails closed (IR-02): unless Netlify confirms this is the production SpinFamily site, nothing is written.
export default {
  async formSubmitted(event, context) {
    const facts = runtimeFacts(context);
    if (!facts.isProduction) {
      console.warn(JSON.stringify({ component: 'ops-intake', state: 'skipped_not_production', deployContext: facts.deployContext, rightSite: facts.rightSite }));
      return;
    }
    // Netlify's submission id and timestamp are kept only if the event actually carries them; none are invented.
    const meta = {
      submissionId: event?.submission?.id ?? event?.id ?? null,
      submittedAt: event?.submission?.created_at ?? event?.created_at ?? null,
    };
    const state = await ingestPilotSubmission({ sql: getDatabase().sql, orgId: OPS_ORG }, event?.data, new Date().toISOString(), meta);
    console.info(JSON.stringify({ component: 'ops-intake', state, provenance: meta.submissionId ? 'event_with_id' : 'event_without_id' }));
  },
};
