# Stripe household correlation gate — NOT YET SATISFIED
Verified existing live Stripe Payment Links:
- Monthly https://buy.stripe.com/28E28tgIs0Kz7hYajZ6EU00
- Annual https://buy.stripe.com/bJe8wRgIs1OD9q677N6EU01

A static hosted link cannot be assumed to carry a secure signed-in household claim. Email matching, customer email, success redirect, and unverified metadata are NOT sufficient for linking accounts.
Before enabling Plus:
1. Decide whether to preserve these links as public purchase links with a secure post-purchase claim process, or append a supported Stripe Payment Link client_reference_id issued server-side for a signed-in household. Verify exact supported API behavior and confirm reference survives to Checkout Session.
2. Verify checkout.session.completed and subscription identity against Stripe API; atomically consume short-lived server-issued claim reference, verify allowed price, link Stripe customer to household.
3. Process subscription updates and invoice events only after verified linkage; verify webhook signature against raw body and dedicated SpinFamily signing secret.
4. Idempotency + ordering: event ID unique, reject stale event.created; ensure invoice payment events cannot resurrect canceled subscriptions; reconcile via Stripe API when uncertain.
5. Isolate production and preview secrets, webhooks, database branches, and PII. The existing ReLayer live webhook must remain untouched.
6. Test full lifecycle with Stripe sandbox fixtures, cross-account attacks, replay, cancellation, expiry, failed payment and deleted account.
No paid entitlement is activated by this document or current code.
