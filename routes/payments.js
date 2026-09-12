const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');
const { paystack, generateReference, placeholderEmail, verifyWebhookSignature } = require('../paystackClient');

const VOTE_PRICE = Number(process.env.VOTE_PRICE || 20);
const MAX_FREE_VOTES_PER_PERSON = Number(process.env.MAX_FREE_VOTES_PER_PERSON || 2);

function normalizePhone(raw) {
  let phone = String(raw).trim().replace(/\s+/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (phone.startsWith('0')) phone = '254' + phone.slice(1);
  return phone;
}

function isValidSafaricomNumber(phone) {
  return /^254(7|1)\d{8}$/.test(phone);
}

const initiateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many payment attempts. Please wait a moment and try again.' }
});

// POST /api/payments/initiate
// body: { nomineeId, phone, votes }
router.post('/initiate', initiateLimiter, async (req, res) => {
  try {
    const { nomineeId, phone, votes } = req.body;
    const voteCount = parseInt(votes, 10);

    if (!nomineeId || !phone || !voteCount || voteCount < 1) {
      return res.status(400).json({ error: 'nomineeId, phone, and votes (>=1) are required' });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!isValidSafaricomNumber(normalizedPhone)) {
      return res.status(400).json({ error: 'Enter a valid Safaricom M-Pesa number' });
    }

    const amount = voteCount * VOTE_PRICE;

    const { data: nominee, error: nomErr } = await supabase
      .from('nominees')
      .select('id, full_name, is_active, category_id, categories!inner(is_active, voting_ends_at)')
      .eq('id', nomineeId)
      .single();

    if (nomErr || !nominee || !nominee.is_active || !nominee.categories.is_active) {
      return res.status(404).json({ error: 'Nominee not found or voting is closed for this category' });
    }

    // The countdown shown on the frontend is only a display — this is what
    // actually stops votes once the deadline passes.
    const deadline = nominee.categories.voting_ends_at;
    if (deadline && new Date(deadline) <= new Date()) {
      return res.status(400).json({ error: 'Voting has closed for this category' });
    }

    // Check for an active Free Voting Day sponsorship on this category —
    // verified server-side against the DB, never trusting a client-supplied
    // "this is free" claim.
    const { data: activeSponsorship } = await supabase
      .from('active_sponsorships')
      .select('id, starts_at')
      .eq('category_id', nominee.category_id)
      .limit(1)
      .maybeSingle();

    if (activeSponsorship) {
      // Unlike paid votes (self-limiting by cost), free votes have no
      // natural brake — cap them per phone number per category per
      // sponsorship window so one person/bot can't dominate a free day.
      const { data: priorFreeVotes } = await supabase
        .from('transactions')
        .select('votes_requested')
        .eq('phone_number', normalizedPhone)
        .eq('category_id', nominee.category_id)
        .eq('status', 'success')
        .eq('amount', 0)
        .gte('created_at', activeSponsorship.starts_at);

      const alreadyUsed = (priorFreeVotes || []).reduce((sum, t) => sum + t.votes_requested, 0);
      const remaining = MAX_FREE_VOTES_PER_PERSON - alreadyUsed;

      if (remaining <= 0) {
        return res.status(400).json({
          error: `You've used all ${MAX_FREE_VOTES_PER_PERSON} free votes for this category today. This limit only applies to free voting days — other categories remain unlimited at KSh ${VOTE_PRICE}/vote.`
        });
      }
      if (voteCount > remaining) {
        return res.status(400).json({
          error: `Only ${remaining} free vote(s) left for you in this category today. Try a smaller number.`
        });
      }

      const { data: freeTxn, error: freeTxnErr } = await supabase
        .from('transactions')
        .insert({
          nominee_id: nomineeId,
          category_id: nominee.category_id,
          phone_number: normalizedPhone,
          amount: 0,
          votes_requested: voteCount,
          status: 'success',
          result_desc: 'Free Voting Day — sponsored'
        })
        .select()
        .single();

      if (freeTxnErr) return res.status(500).json({ error: freeTxnErr.message });

      const voteRows = Array.from({ length: voteCount }, () => ({
        nominee_id: nomineeId,
        transaction_id: freeTxn.id
      }));
      const { error: voteErr } = await supabase.from('votes').insert(voteRows);
      if (voteErr) return res.status(500).json({ error: voteErr.message });

      return res.json({
        free: true,
        message: `Free Voting Day — ${voteCount} vote(s) recorded instantly, no payment needed!`,
        transactionId: freeTxn.id
      });
    }

    const { data: txn, error: txnErr } = await supabase
      .from('transactions')
      .insert({
        nominee_id: nomineeId,
        category_id: nominee.category_id,
        phone_number: normalizedPhone,
        amount,
        votes_requested: voteCount,
        status: 'pending'
      })
      .select()
      .single();

    if (txnErr) return res.status(500).json({ error: txnErr.message });

    // Reference is generated and saved BEFORE calling Paystack, so we always
    // have a way to check status even if the /charge call times out or
    // errors. No cold-start race needed here — Paystack is a stable hosted
    // API, not a free-tier service that needs minutes to wake up.
    const reference = generateReference('vote', txn.id);
    await supabase.from('transactions').update({ paystack_reference: reference }).eq('id', txn.id);

    try {
      const { data } = await paystack.post('/charge', {
        email: placeholderEmail(normalizedPhone),
        amount: String(amount * 100), // Paystack reads KES in the smallest unit (cents)
        currency: 'KES',
        reference,
        mobile_money: { phone: `+${normalizedPhone}`, provider: 'mpesa' }
      });

      const status = data.data?.status;

      if (status === 'success') {
        await creditOrFailTransaction(txn, 'success', { raw: data.data });
        return res.json({ message: 'Payment confirmed. Thank you for voting!', transactionId: txn.id });
      }

      if (status === 'failed') {
        await supabase
          .from('transactions')
          .update({ status: 'failed', result_desc: data.data?.gateway_response || 'Payment failed' })
          .eq('id', txn.id);
        return res.status(502).json({ error: data.data?.gateway_response || 'Payment failed. Please try again.' });
      }

      // pay_offline / send_otp / pending — STK prompt is out on the
      // customer's phone. Leave pending; /status polling and the webhook
      // will resolve it.
      return res.json({
        message: 'STK Push sent. Enter your M-Pesa PIN on your phone to complete payment.',
        transactionId: txn.id
      });
    } catch (pushErr) {
      console.error(
        '[payments/initiate] Paystack /charge request failed:',
        pushErr.response?.status,
        pushErr.response?.data || pushErr.message
      );
      // We already saved our own reference, so we don't need to guess here —
      // leave the transaction pending and let /status and the webhook
      // resolve it once Paystack catches up.
      return res.json({
        message: 'STK Push sent. If you don\u2019t see a prompt within a minute, you can try again.',
        transactionId: txn.id
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error initiating payment' });
  }
});

// GET /api/payments/status/:transactionId — polled by the frontend.
router.get('/status/:transactionId', async (req, res) => {
  const { data: txn, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', req.params.transactionId)
    .single();

  if (error || !txn) return res.status(404).json({ error: 'Transaction not found' });

  if (txn.status === 'pending' && txn.paystack_reference) {
    try {
      const { data } = await paystack.get(`/charge/${txn.paystack_reference}`);
      const providerStatus = data.data?.status;

      if (providerStatus === 'success') {
        await creditOrFailTransaction(txn, 'success', { raw: data.data, reason: data.data?.gateway_response });
        return res.json({ status: 'success', votes_requested: txn.votes_requested });
      }
      if (providerStatus === 'failed') {
        await creditOrFailTransaction(txn, 'failed', { reason: data.data?.gateway_response, raw: data.data });
        return res.json({ status: 'failed', votes_requested: txn.votes_requested });
      }
    } catch (_) {
      // Ignore — webhook is still the primary path; this is a fallback poll.
    }
  }

  res.json({ status: txn.status, votes_requested: txn.votes_requested, mpesa_receipt: txn.mpesa_receipt });
});

async function creditOrFailTransaction(txn, status, extra) {
  const { data: fresh } = await supabase
    .from('transactions')
    .select('status')
    .eq('id', txn.id)
    .single();
  if (fresh.status === 'success' || fresh.status === 'failed') return; // idempotency guard

  await supabase
    .from('transactions')
    .update({
      status,
      mpesa_receipt: extra.receiptUrl || null,
      result_desc: extra.reason || null,
      raw_callback: extra.raw || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', txn.id);

  if (status === 'success') {
    const voteRows = Array.from({ length: txn.votes_requested }, () => ({
      nominee_id: txn.nominee_id,
      transaction_id: txn.id
    }));
    await supabase.from('votes').insert(voteRows);
  }
}

// POST /api/payments/webhook — Paystack calls this on charge.success /
// charge.failed, for ALL THREE payment flows (votes, sponsorships, and
// nomination applications), since they all share this one webhook URL.
// Because each flow generates its own unique `reference` up front and
// saves it immediately, we can look it up directly in whichever table it
// belongs to — no amount-based fallback matching, so there's no way to
// credit the wrong voter/sponsor/applicant the way an ambiguous match
// could under the old FXS Pay integration.
router.post('/webhook', async (req, res) => {
  try {
    if (!verifyWebhookSignature(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    // Acknowledge immediately — Paystack retries if we're slow to respond.
    res.status(200).json({ message: 'Received' });

    const { event, data } = req.body;
    const reference = data?.reference;
    if (!reference || (event !== 'charge.success' && event !== 'charge.failed')) return;

    const status = event === 'charge.success' ? 'success' : 'failed';

    const { data: txn } = await supabase
      .from('transactions')
      .select('*')
      .eq('paystack_reference', reference)
      .single();

    if (txn) {
      await creditOrFailTransaction(txn, status, { reason: data.gateway_response, receiptUrl: data.receipt_number, raw: data });
      return;
    }

    const { data: sponsorship } = await supabase
      .from('sponsorships')
      .select('*')
      .eq('paystack_reference', reference)
      .single();

    if (sponsorship) {
      if (status === 'success') {
        const { activateSponsorship } = require('./sponsorship');
        await activateSponsorship(sponsorship);
      } else {
        await supabase.from('sponsorships').update({ status: 'failed' }).eq('id', sponsorship.id);
      }
      return;
    }

    const { data: application } = await supabase
      .from('nomination_applications')
      .select('*')
      .eq('paystack_reference', reference)
      .single();

    if (application) {
      if (status === 'success') {
        const { markApplicationPaid } = require('./nominations');
        await markApplicationPaid(application);
      } else {
        await supabase.from('nomination_applications').update({ payment_status: 'failed' }).eq('id', application.id);
      }
      return;
    }

    console.error('[webhook] no matching transaction, sponsorship, or application for reference', reference);
  } catch (err) {
    console.error('[webhook] error processing event:', err.message);
    // Response already sent above — nothing further to return here.
  }
});

module.exports = router;
