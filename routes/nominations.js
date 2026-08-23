const express = require('express');
const router = express.Router();
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');

const APPLICATION_FEE = Number(process.env.APPLICATION_FEE || 200);

const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  timeout: 20000
});

const applyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many applications submitted. Please wait a moment and try again.' }
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

// POST /api/nominations/apply
// body: { fullName, email, phone, whatsapp, categoryId }
router.post('/apply', applyLimiter, async (req, res) => {
  try {
    const { fullName, email, phone, whatsapp, categoryId } = req.body;

    if (!fullName || !fullName.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }
    if (!categoryId) {
      return res.status(400).json({ error: 'Please choose a category' });
    }
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!isValidSafaricomNumber(normalizedPhone)) {
      return res.status(400).json({ error: 'Enter a valid Safaricom phone number' });
    }

    let normalizedWhatsapp = null;
    if (whatsapp && whatsapp.trim()) {
      normalizedWhatsapp = normalizePhone(whatsapp);
      if (!isValidSafaricomNumber(normalizedWhatsapp)) {
        return res.status(400).json({ error: 'Enter a valid WhatsApp number, or leave it blank' });
      }
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address, or leave it blank' });
    }

    const { data: category, error: catErr } = await supabase
      .from('categories')
      .select('id, is_active')
      .eq('id', categoryId)
      .single();

    if (catErr || !category || !category.is_active) {
      return res.status(404).json({ error: 'Category not found or not currently open' });
    }

    const { data: application, error: insertErr } = await supabase
      .from('nomination_applications')
      .insert({
        full_name: fullName.trim(),
        email: email ? email.trim() : null,
        phone_number: normalizedPhone,
        whatsapp_number: normalizedWhatsapp,
        category_id: categoryId,
        status: 'pending',
        amount: APPLICATION_FEE,
        payment_status: 'pending'
      })
      .select()
      .single();

    if (insertErr) return res.status(500).json({ error: insertErr.message });

    try {
      const { data } = await paystack.post('/charge', {
        email: `v${normalizedPhone}@gmail.com`,
        amount: APPLICATION_FEE * 100, // Paystack reads KES amounts in subunits — see payments.js for how this was confirmed
        currency: 'KES',
        mobile_money: {
          phone: `+${normalizedPhone}`,
          provider: 'mpesa'
        }
      });

      await supabase
        .from('nomination_applications')
        .update({ fxs_reference: data.data.reference })
        .eq('id', application.id);

      return res.json({
        message: data.data.display_text || 'STK Push sent. Enter your M-Pesa PIN to pay the KSh 200 application fee.',
        applicationId: application.id
      });
    } catch (pushErr) {
      const providerMsg = pushErr.response?.data?.message;
      await supabase
        .from('nomination_applications')
        .update({ payment_status: 'failed' })
        .eq('id', application.id);
      return res.status(502).json({ error: providerMsg || 'Could not start payment. Please try again.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error submitting application' });
  }
});

// GET /api/nominations/status/:applicationId — polled by the frontend
router.get('/status/:applicationId', async (req, res) => {
  const { data: application, error } = await supabase
    .from('nomination_applications')
    .select('*')
    .eq('id', req.params.applicationId)
    .single();

  if (error || !application) return res.status(404).json({ error: 'Application not found' });

  if (application.payment_status === 'pending' && application.fxs_reference) {
    try {
      const { data } = await paystack.get(`/transaction/verify/${application.fxs_reference}`);
      const providerStatus = data.data?.status;

      if (providerStatus === 'success') {
        await markApplicationPaid(application);
        return res.json({ payment_status: 'success' });
      }
      if (providerStatus === 'failed' || providerStatus === 'abandoned') {
        await supabase.from('nomination_applications').update({ payment_status: 'failed' }).eq('id', application.id);
        return res.json({ payment_status: 'failed' });
      }
    } catch (_) {
      // Ignore — webhook is still the primary path; this is a fallback poll.
    }
  }

  res.json({ payment_status: application.payment_status });
});

// Marks the application's fee as paid — idempotent, safe to call from both
// the webhook and the status-poll fallback. Application only becomes
// visible in the admin review queue once this has run.
async function markApplicationPaid(application) {
  const { data: fresh } = await supabase
    .from('nomination_applications')
    .select('payment_status')
    .eq('id', application.id)
    .single();
  if (fresh.payment_status === 'success' || fresh.payment_status === 'failed') return; // idempotency guard

  await supabase
    .from('nomination_applications')
    .update({ payment_status: 'success' })
    .eq('id', application.id);
}

module.exports = { router, markApplicationPaid };
