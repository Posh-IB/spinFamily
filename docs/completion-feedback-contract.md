# Completed household plans to private suggestions

Candidate for Issue #11 / draft PR #12. Not a production release.

POST /api/household/suggestions resolves the household from verified Identity and requires current verified Plus access. The request accepts caregiver time, energy, preferred, excluded, required/pinned and routine choices, plus fixed commitments. It never accepts household IDs, history, target dates, child profiles or a client catalog.

The server reads existing saved_plans rows scoped to that household and sends only explicit_caregiver completions in a schemaVersion 1 authorized_household_completion envelope. Dates come from the actual completion timestamp in the fixed household timezone. Activity identifiers are stable normalized category/name digests; names and account/member identifiers are omitted from history. The private engine receives a server-owned at-home curated catalog and tomorrow's household-local date.

The private deterministic planner remains in the private repository. Public code contains authorization, contract translation, output validation and display only. The private transport requires HTTPS, a server credential and an eight-second deadline, refuses redirects, and fails closed. The new endpoint is disabled in production in this candidate.

Routine and must-include choices are hard constraints. Explicit exclusions are hard constraints. A contradiction or infeasible window never silently removes them. Suggestions contain at most three activities and need not fill the window. Outdoor availability/travel, custom-activity metadata, saving suggested plans and hosted authenticated verification remain separate gates.

Completion records remain the only authority for streak credit: one day per household-local date after explicit caregiver confirmation of an entire saved plan. Novelty, selection and suggestion generation do not change streak credit.

Validation is recorded in the PR and canonical Rootlayer engineering record. Browser fixtures are synthetic UI evidence, not proof of a paid hosted session. A ready Netlify preview is not proof of private-service configuration or a successful personalized request.

