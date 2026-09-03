const express = require('express');
const router = express.Router();
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');

const SPONSOR_DAY_PRICE = Number(process.env.SPONSOR_DAY_PRICE || 50000);

const fxspay = axios.create({
  baseURL: process.env.FXS_BASE_URL || 'https://fxspay.onrender.com',
  headers: { Authorization: `Bearer ${process.env.FXS_API_KEY}` },
  timeout: 45000 // generous — FXS Pay's own Render free-tier backend can take 30s+ to cold-start
});

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

    try {
      // FXS Pay takes plain whole/decimal KES amounts — no subunit conversion.
      const { data } = await fxspay.post('/api/mpesa/stk-push', {
        phone: normalizedPhone,
        amount,
        description: `${dayCount} day(s) Free Voting Day sponsorship — ${category.name}`,
        email: `v${normalizedPhone}@gmail.com`
      });

      await supabase
        .from('sponsorships')
        .update({ fxs_reference: data.transactionId })
        .eq('id', sponsorship.id);

      return res.json({
        message: data.message || 'STK Push sent. Enter your M-Pesa PIN on your phone to complete payment.',
        sponsorshipId: sponsorship.id
      });
    } catch (pushErr) {
      const providerMsg = pushErr.response?.data?.error;
      console.error(
        '[sponsorship/initiate] FXS Pay stk-push failed:',
        pushErr.response?.status,
        pushErr.response?.data || pushErr.message
      );
      await supabase
        .from('sponsorships')
        .update({ status: 'failed', result_desc: providerMsg || pushErr.message || 'Charge request failed' })
        .eq('id', sponsorship.id);
      return res.status(502).json({ error: providerMsg || 'Could not start payment. Please try again.' });
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

  if (sponsorship.status === 'pending' && sponsorship.fxs_reference) {
    try {
      const { data } = await fxspay.get(`/api/mpesa/status/${sponsorship.fxs_reference}`);
      const providerStatus = data.transaction?.status;

      if (providerStatus === 'success') {
        await activateSponsorship(sponsorship);
        return res.json({ status: 'success', days: sponsorship.days });
      }
      if (providerStatus === 'failed') {
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
