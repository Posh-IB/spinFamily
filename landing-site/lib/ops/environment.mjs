// R2-02: prove which kind of database this is before any route serves data.
//
//  production context  -> marker missing: write 'production' (first run). 'production': ok. 'synthetic': refuse.
//  preview contexts    -> marker 'synthetic': ok. 'production' (a fork of production): refuse.
//                         marker missing: ok only if the database holds no records at all, then write 'synthetic'.
//
// A preview database that Netlify forks from production after launch inherits the 'production'
// marker, so previews of the workspace switch themselves off rather than show real people.
const DATA_TABLES = ['members', 'participants', 'pilot_intake_records', 'sessions', 'login_links', 'survey_responses', 'survey_invites', 'documents', 'audit_events', 'approvals', 'research_consents'];

export async function checkEnvironment(sql, facts, nowIso = new Date().toISOString()) {
  if (!facts?.supported) return { ok: false, reason: 'unsupported_context' };
  const want = facts.isProduction ? 'production' : 'synthetic';
  let marker = (await sql`SELECT kind, site_id FROM ops_environment WHERE singleton`)[0];
  if (!marker) {
    if (!facts.isProduction) {
      const counts = await sql.unsafe(`SELECT ${DATA_TABLES.map(t => `(SELECT count(*) FROM ${t})::int AS ${t}`).join(', ')}`);
      const used = Object.entries(counts[0]).filter(([, n]) => n > 0).map(([t]) => t);
      if (used.length) return { ok: false, reason: 'unmarked_database_has_data', tables: used };
    }
    await sql`INSERT INTO ops_environment (singleton, kind, site_id, context, marked_at) VALUES (true, ${want}, ${facts.siteId}, ${facts.deployContext}, ${nowIso}) ON CONFLICT (singleton) DO NOTHING`;
    marker = (await sql`SELECT kind, site_id FROM ops_environment WHERE singleton`)[0];
  }
  if (marker.site_id !== facts.siteId) return { ok: false, reason: 'database_from_another_site' };
  if (marker.kind !== want) return { ok: false, reason: facts.isProduction ? 'production_on_synthetic_database' : 'preview_on_production_data' };
  return { ok: true, kind: marker.kind };
}
