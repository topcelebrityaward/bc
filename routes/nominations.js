const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');

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
// body: { fullName, email, phone, categoryId }
router.post('/apply', applyLimiter, async (req, res) => {
  try {
    const { fullName, email, phone, categoryId } = req.body;

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
        category_id: categoryId,
        status: 'pending'
      })
      .select()
      .single();

    if (insertErr) return res.status(500).json({ error: insertErr.message });

    res.json({
      message: 'Your application has been submitted! We\u2019ll review it and be in touch.',
      applicationId: application.id
    });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error submitting application' });
  }
});

module.exports = router;
