import { getDatabase } from '@netlify/database';
import { ingestPilotSubmission } from '../../lib/ops/records.mjs';
import { makeDb } from '../../lib/ops/db.mjs';
import { checkEnvironment } from '../../lib/ops/environment.mjs';
import { runtimeFacts, OPS_ORG } from '../../lib/ops/runtime.mjs';

// Copies each new pilot-form registration into the operations workspace.
// Runs alongside pilot-welcome; it never sends email and never touches the welcome ledger.
// Fails closed (IR-02, R2-02): unless Netlify confirms this is the production SpinFamily site AND the
// database confirms it is the production database, nothing is written.
export default {
  async formSubmitted(event, context) {
    const facts = runtimeFacts(context);
    if (!facts.isProduction) {
      console.warn(JSON.stringify({ component: 'ops-intake', state: 'skipped_not_production', deployContext: facts.deployContext, rightSite: facts.rightSite }));
      return;
    }
    const db = makeDb(getDatabase().pool);
    const env = await checkEnvironment(db.sql, facts);
    if (!env.ok) { console.warn(JSON.stringify({ component: 'ops-intake', state: 'skipped_database_environment', reason: env.reason })); return; }
    // Netlify's submission id and timestamp are kept only if the event actually carries them; none are invented.
    const meta = {
      submissionId: event?.submission?.id ?? event?.id ?? null,
      submittedAt: event?.submission?.created_at ?? event?.created_at ?? null,
    };
    // One transaction; a failure leaves nothing behind and the same event can be delivered again safely.
    const state = await ingestPilotSubmission({ sql: db.sql, tx: db.tx, orgId: OPS_ORG, now: () => Date.now() }, event?.data, new Date().toISOString(), meta);
    console.info(JSON.stringify({ component: 'ops-intake', state, provenance: meta.submissionId ? 'event_with_id' : 'event_without_id' }));
  },
};
