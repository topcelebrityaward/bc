const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');
const { paystack, generateReference, placeholderEmail, TERMINAL_FAILURE_STATUSES } = require('../paystackClient');

const SPONSOR_DAY_PRICE = Number(process.env.SPONSOR_DAY_PRICE || 50000);

const initiateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts. Please wait a moment and try again.' }
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

// POST /api/sponsorship/initiate
// body: { categoryId, days, phone }
router.post('/initiate', initiateLimiter, async (req, res) => {
  try {
    const { categoryId, days, phone } = req.body;
    const dayCount = parseInt(days, 10);

    if (!categoryId || !phone || !dayCount || dayCount < 1) {
      return res.status(400).json({ error: 'categoryId, phone, and days (>=1) are required' });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!isValidSafaricomNumber(normalizedPhone)) {
      return res.status(400).json({ error: 'Enter a valid Safaricom M-Pesa number' });
    }

    const { data: category, error: catErr } = await supabase
      .from('categories')
      .select('id, name, is_active')
      .eq('id', categoryId)
      .single();

    if (catErr || !category || !category.is_active) {
      return res.status(404).json({ error: 'Category not found or not currently open' });
    }

    const amount = dayCount * SPONSOR_DAY_PRICE;

    const { data: sponsorship, error: insertErr } = await supabase
      .from('sponsorships')
      .insert({
        category_id: categoryId,
        days: dayCount,
        amount,
        phone_number: normalizedPhone,
        status: 'pending'
      })
      .select()
      .single();

    if (insertErr) return res.status(500).json({ error: insertErr.message });

    // Reference is generated and saved BEFORE calling Paystack — see
    // payments.js for why this removes the need for any cold-start
    // race or ambiguous phone/amount reconciliation.
    const reference = generateReference('sponsor', sponsorship.id);
    await supabase.from('sponsorships').update({ paystack_reference: reference }).eq('id', sponsorship.id);

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
        await activateSponsorship(sponsorship);
        return res.json({ message: 'Payment confirmed! Free voting day activated.', sponsorshipId: sponsorship.id });
      }

      if (TERMINAL_FAILURE_STATUSES.includes(status)) {
        await supabase
          .from('sponsorships')
          .update({ status: 'failed', result_desc: data.data?.gateway_response || 'Payment failed' })
          .eq('id', sponsorship.id);
        return res.status(502).json({ error: data.data?.gateway_response || 'Payment failed. Please try again.' });
      }

      return res.json({
        message: 'STK Push sent. Enter your M-Pesa PIN on your phone to complete payment.',
        sponsorshipId: sponsorship.id
      });
    } catch (pushErr) {
      console.error(
        '[sponsorship/initiate] Paystack /charge request failed:',
        pushErr.response?.status,
        pushErr.response?.data || pushErr.message
      );
      return res.json({
        message: 'STK Push sent. If you don\u2019t see a prompt within a minute, you can try again.',
        sponsorshipId: sponsorship.id
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error initiating sponsorship' });
  }
});

// GET /api/sponsorship/status/:sponsorshipId — polled by the frontend
router.get('/status/:sponsorshipId', async (req, res) => {
  const { data: sponsorship, error } = await supabase
    .from('sponsorships')
    .select('*')
    .eq('id', req.params.sponsorshipId)
    .single();

  if (error || !sponsorship) return res.status(404).json({ error: 'Sponsorship not found' });

  if (sponsorship.status === 'pending' && sponsorship.paystack_reference) {
    try {
      const { data } = await paystack.get(`/charge/${sponsorship.paystack_reference}`);
      const providerStatus = data.data?.status;

      if (providerStatus === 'success') {
        await activateSponsorship(sponsorship);
        return res.json({ status: 'success', days: sponsorship.days });
      }
      if (TERMINAL_FAILURE_STATUSES.includes(providerStatus)) {
        await supabase.from('sponsorships').update({ status: 'failed' }).eq('id', sponsorship.id);
        return res.json({ status: 'failed' });
      }
    } catch (_) {
      // Ignore — webhook is still the primary path; this is a fallback poll.
    }
  }

  res.json({ status: sponsorship.status, days: sponsorship.days });
});

// Marks a sponsorship as paid and opens its free-voting window, starting now.
// Idempotent — safe to call from both the webhook and the status-poll fallback.
async function activateSponsorship(sponsorship) {
  const { data: fresh } = await supabase
    .from('sponsorships')
    .select('status')
    .eq('id', sponsorship.id)
    .single();
  if (fresh.status === 'success' || fresh.status === 'failed') return; // idempotency guard

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + sponsorship.days * 24 * 60 * 60 * 1000);

  await supabase
    .from('sponsorships')
    .update({
      status: 'success',
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', sponsorship.id);
}

module.exports = { router, activateSponsorship };
