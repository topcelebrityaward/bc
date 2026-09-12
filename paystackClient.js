const crypto = require('crypto');
const axios = require('axios');

// Paystack's API base URL is fixed — unlike FXS Pay, there's no per-merchant
// or per-environment URL to configure. Test vs live is controlled entirely
// by which secret key you use (sk_test_... vs sk_live_...).
const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  timeout: 30000
});

// We generate our OWN reference before ever calling Paystack, and save it
// immediately. This is the key difference from the FXS Pay integration:
// FXS Pay only handed back a transactionId on a clean response, which meant
// a timeout/cold-start/error left us with no reliable id to poll or match
// a webhook against — hence the old code's Promise.race + "reconcile by
// phone+amount" workarounds. With Paystack, GET /charge/:reference always
// works for a reference we made up ourselves, so none of that is needed.
function generateReference(prefix, id) {
  return `${prefix}_${id}_${crypto.randomBytes(4).toString('hex')}`;
}

// Paystack requires an `email` on every /charge call even though it's
// unused for mobile money. Voters/applicants/sponsors don't provide one
// everywhere in this flow, so we synthesize a placeholder.
//
// IMPORTANT: this must use a real, recognized TLD or Paystack's own email
// validator rejects it outright ("email must be a valid email") — a made-up
// TLD like .local looks email-shaped but isn't accepted. example.com is the
// right choice here: it's reserved by IANA specifically for documentation/
// placeholder use (RFC 2606), has a valid TLD so format validators accept
// it, and is guaranteed to never deliver mail to a real inbox.
function placeholderEmail(phone) {
  return `voter-${phone}@example.com`;
}

// Verifies Paystack's webhook signature: HMAC-SHA512 of the raw request
// body, keyed with your PAYSTACK_SECRET_KEY (the same key used for API
// calls — Paystack has no separate webhook secret to register or store).
function verifyWebhookSignature(req) {
  const signature = req.headers['x-paystack-signature'];
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
    .digest('hex');

  return signature === expected;
}

module.exports = { paystack, generateReference, placeholderEmail, verifyWebhookSignature };
