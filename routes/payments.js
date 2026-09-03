const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');

const VOTE_PRICE = Number(process.env.VOTE_PRICE || 20);
const MAX_FREE_VOTES_PER_PERSON = Number(process.env.MAX_FREE_VOTES_PER_PERSON || 2);

const fxspay = axios.create({
  baseURL: process.env.FXS_BASE_URL || 'https://fxspay.onrender.com',
  headers: { Authorization: `Bearer ${process.env.FXS_API_KEY}` },
  timeout: 45000 // generous — FXS Pay's own Render free-tier backend can take 30s+ to cold-start
});

const initiateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many payment attempts. Please wait a moment and try again.' }
});

function normalizePhone(raw) {
  let phone = String(raw).trim().replace(/\s+/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (phone.startsWith('0')) phone = '254' + phone.slice(1);
  return phone;
}

function isValidSafaricomNumber(phone) {
  return /^254(7|1)\d{8}$/.test(phone);
}

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

    // Confirm the nominee up front — FXS Pay's stk-push call only returns
    // "started" (202), not a synchronous success/fail, so there's no
    // benefit to firing it before we know the nominee is valid.
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

    try {
      // FXS Pay takes amounts as plain whole/decimal KES — no subunit
      // conversion needed (unlike Paystack, which reads KES in subunits).
      const { data } = await fxspay.post('/api/mpesa/stk-push', {
        phone: normalizedPhone,
        amount,
        description: `${voteCount} vote(s) for ${nominee.full_name}`,
        email: `v${normalizedPhone}@gmail.com`
      });

      // FXS Pay's own transaction id — this is what the webhook and the
      // /api/mpesa/status/:transactionId poll both reference later.
      await supabase
        .from('transactions')
        .update({ fxs_reference: data.transactionId })
        .eq('id', txn.id);

      return res.json({
        message: data.message || 'STK Push sent. Enter your M-Pesa PIN on your phone to complete payment.',
        transactionId: txn.id
      });
    } catch (pushErr) {
      const providerMsg = pushErr.response?.data?.error;
      console.error(
        '[payments/initiate] FXS Pay stk-push failed:',
        pushErr.response?.status,
        pushErr.response?.data || pushErr.message
      );
      await supabase
        .from('transactions')
        .update({ status: 'failed', result_desc: providerMsg || pushErr.message || 'Charge request failed' })
        .eq('id', txn.id);
      return res.status(502).json({ error: providerMsg || 'Could not start payment. Please try again.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error initiating payment' });
  }
});

// GET /api/payments/status/:transactionId — polled by the frontend.
// Falls back to FXS Pay's status endpoint if still pending and no webhook
// has landed yet.
router.get('/status/:transactionId', async (req, res) => {
  const { data: txn, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', req.params.transactionId)
    .single();

  if (error || !txn) return res.status(404).json({ error: 'Transaction not found' });

  if (txn.status === 'pending' && txn.fxs_reference) {
    try {
      const { data } = await fxspay.get(`/api/mpesa/status/${txn.fxs_reference}`);
      const providerStatus = data.transaction?.status; // 'pending' | 'success' | 'failed'

      if (providerStatus === 'success') {
        await creditOrFailTransaction(txn, 'success', { raw: data.transaction });
        return res.json({ status: 'success', votes_requested: txn.votes_requested });
      }
      if (providerStatus === 'failed') {
        await creditOrFailTransaction(txn, 'failed', { reason: providerStatus, raw: data.transaction });
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

// POST /api/payments/webhook — FXS Pay calls this on payment.success /
// payment.failed. Signature is a hex HMAC-SHA256 of the raw JSON body,
// computed with the webhook secret you got back when registering this URL
// via POST /api/webhook/endpoints (separate from your FXS_API_KEY). Set
// FXS_WEBHOOK_SECRET in .env to that value.
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-fxspay-signature'];
    const expected = crypto
      .createHmac('sha256', process.env.FXS_WEBHOOK_SECRET)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
      .digest('hex');

    if (!signature || signature !== expected) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    // Acknowledge immediately — FXS Pay times out and retries if we're slow
    res.status(200).json({ message: 'Received' });

    const event = req.headers['x-fxspay-event'];
    const { transactionId, reason, receiptUrl } = req.body;
    if (!transactionId || (event !== 'payment.success' && event !== 'payment.failed')) return;

    const { data: txn } = await supabase
      .from('transactions')
      .select('*')
      .eq('fxs_reference', transactionId)
      .single();

    const status = event === 'payment.success' ? 'success' : 'failed';

    if (txn) {
      await creditOrFailTransaction(txn, status, { reason, receiptUrl, raw: req.body });
      return;
    }

    // Not a vote payment — check if it's a Free Voting Day sponsorship instead
    const { data: sponsorship } = await supabase
      .from('sponsorships')
      .select('*')
      .eq('fxs_reference', transactionId)
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

    // Not that either — check if it's a nomination application fee
    const { data: application } = await supabase
      .from('nomination_applications')
      .select('*')
      .eq('fxs_reference', transactionId)
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

    console.error('[webhook] no matching transaction, sponsorship, or application for', transactionId);
  } catch (err) {
    console.error('[webhook] error processing event:', err.message);
    // Response already sent above — nothing further to return here.
  }
});

module.exports = router;
