# Top Celebrities Award (TCA) — Voting Platform

A public voting site: KSh 20/vote via M-Pesa STK Push (through FXS Pay),
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
- `FXS_API_KEY`, `FXS_WEBHOOK_SECRET` — **see the FXS Pay setup below**

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
FXS_API_KEY, FXS_WEBHOOK_SECRET) still need to be filled in manually from
the dashboard — Blueprints don't auto-fill secrets.

## 3. FXS Pay setup

`routes/payments.js`, `routes/sponsorship.js`, and `routes/nominations.js`
all call FXS Pay's M-Pesa STK Push API (`https://fxspay.onrender.com`) to
collect payment. No card data ever touches this backend.

1. **Register a merchant account**: `POST /api/merchant/register` with your
   business name, email, and a password. This returns a `token` you can use
   right away, but a **live** API key needs your account approved first (a
   **test** key can be generated immediately regardless of approval status).
2. **Generate an API key**: `POST /api/merchant/api-key` with
   `{ "env": "live" }` (or `"test"` while testing). **The full key is shown
   exactly once** — copy it straight into `.env` as `FXS_API_KEY`. FXS Pay
   never displays or stores the full value again; if you lose it, generate
   a new one.
3. **Deploy the backend** (Render) first, then **register your webhook
   URL**: `POST /api/webhook/endpoints` with
   `{ "url": "https://your-backend.onrender.com/api/payments/webhook" }`
   (send this request using your API key for auth — e.g. via curl or
   Postman). The response includes a `secret`, shown once — copy it into
   `.env` as `FXS_WEBHOOK_SECRET`. Unlike a Paystack-style setup, FXS Pay
   uses this separate webhook secret rather than your API key to sign
   webhook payloads.
4. **Test with a small real vote first** and check the actual amount
   charged on your phone. FXS Pay takes amounts as plain whole/decimal KES
   (not subunits) — this is what the code assumes, but it's worth
   confirming directly rather than trusting blindly, since getting it
   wrong means over- or under-charging every voter.

How it works: each route calls FXS Pay's `POST /api/mpesa/stk-push` with
`{ phone, amount, description, email }`, which returns `202` immediately
with a `transactionId` — a "started" acknowledgement, not a synchronous
success/fail. `POST /api/payments/webhook` verifies FXS Pay's HMAC-SHA256
signature (header `X-FXSPay-Signature`, computed over the raw request body
using `FXS_WEBHOOK_SECRET`) and credits votes on the `payment.success`
event (header `X-FXSPay-Event`). The status endpoints also fall back to
FXS Pay's `GET /api/mpesa/status/:transactionId` if a webhook hasn't
arrived within the request window.

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
