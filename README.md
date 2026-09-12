# Top Celebrities Award (TCA) — Voting Platform

A public voting site: KSh 20/vote via M-Pesa STK Push (through Paystack),
unlimited votes per person, live public results, and an admin dashboard
for managing categories, nominees, and payments.

## Structure

```
backend/    Express API + Supabase (deploy to Render)
frontend/   Public site + admin dashboard (static HTML/JS — deploy to GitHub Pages
            or any static host)
```

## 1. Set up Supabase

1. Create a Supabase project.
2. Open the SQL editor and run `backend/schema.sql`.
3. Copy your project URL and **service role key** (Settings → API) — you'll
   need these for the backend `.env`. The service role key is server-only;
   never put it in the frontend.

## 2. Configure the backend

```
cd backend
cp .env.example .env
npm install
```

Fill in `.env`:
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — from step 1
- `JWT_SECRET` — any long random string
- `PAYSTACK_SECRET_KEY` — **see the Paystack setup below**

Create your first admin login:
```
node create-admin.js you@example.com "a-strong-password" "Your Name"
```

Run locally:
```
npm run dev
```

Deploy to Render the same way you deploy your other Node/Express APIs —
either connect your repo directly (Render auto-detects `npm start`), or use
the included `backend/render.yaml` Blueprint (New → Blueprint in Render,
point it at the repo). Either way, the `sync: false` variables in
`render.yaml` (JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
PAYSTACK_SECRET_KEY) still need to be filled in manually from the
dashboard — Blueprints don't auto-fill secrets.

## 3. Paystack setup

`routes/payments.js`, `routes/sponsorship.js`, and `routes/nominations.js`
all call Paystack's Charge API (`https://api.paystack.co/charge`, fixed —
no base URL to configure) with `mobile_money: { provider: "mpesa" }` to
collect payment via M-Pesa STK Push. No card data ever touches this backend.

1. **Get your secret key**: Paystack Dashboard → Settings → API Keys &
   Webhooks. Use `sk_test_...` while testing; switch to `sk_live_...` once
   your account is approved for M-Pesa mobile money in Kenya (a separate
   activation from card payments — request it if it's not already enabled).
   Put it in `.env` as `PAYSTACK_SECRET_KEY`. This one key covers both API
   auth and webhook signature verification — there is no separate webhook
   secret to generate.
2. **Deploy the backend** (Render) first, then set your webhook URL by
   hand: Dashboard → Settings → API Keys & Webhooks → Webhook URL:
   `https://your-backend.onrender.com/api/payments/webhook`
   (set this for both Test and Live mode — there's no API call to register
   it, unlike FXS Pay).
3. **Test with a small real vote first** and check the actual amount
   charged on your phone. Paystack reads KES amounts in the smallest unit
   (cents) — the code already multiplies by 100 before sending — but it's
   worth confirming directly rather than trusting blindly, since getting
   this wrong means over- or under-charging every voter by 100x.

How it works: each route generates its own unique `reference` and saves it
*before* calling Paystack, then calls `POST /charge` with
`{ email, amount, currency: "KES", reference, mobile_money: { phone, provider: "mpesa" } }`.
Because the reference is ours from the start, there's no ambiguity later —
`GET /charge/:reference` (used by the `/status` polling endpoints) and the
webhook both resolve against that exact reference, with no amount-based
guessing needed. `POST /api/payments/webhook` verifies Paystack's
HMAC-SHA512 signature (header `x-paystack-signature`, computed over the
raw request body using `PAYSTACK_SECRET_KEY`) and, on `charge.success` /
`charge.failed`, looks the reference up across `transactions`,
`sponsorships`, and `nomination_applications` (all three flows share this
one webhook URL) to credit the right one.

## 4. Configure and deploy the frontend

In `frontend/js/app.js` and `frontend/js/admin.js`, either set
`window.TCA_API_BASE` before the script loads, or edit the `API_BASE`
fallback directly to point at your deployed Render URL, e.g.:

```html
<script>window.TCA_API_BASE = 'https://your-api.onrender.com/api';</script>
<script src="js/app.js"></script>
```

Then push `frontend/` to GitHub Pages as usual.

## 5. Notes on the categories that include real public figures

The politics category (and any entertainment nominees who are real named
individuals) means real people's names, photos, and bios will appear
attached to a paid competition. Worth confirming you have the standing to
do that — sponsor backing, nominee awareness, or at minimum a clear public
disclaimer — before opening voting on those categories specifically. The
admin dashboard lets you open/close voting per category, so you can launch
entertainment categories immediately and hold back politics until that's
settled.
