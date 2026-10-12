'use strict';
// Fail-closed deployment adapter. Database and verified Stripe entitlement adapters
// must be supplied before activation. Do not expose a writable unauthenticated API.
const {handleCustomActivity}=require('../../lib/household-boundary.cjs');
exports.handler=(event,context)=>handleCustomActivity(event,context);
