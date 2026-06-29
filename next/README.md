# Granite Logistics — Next.js + Supabase

A Next.js (App Router) implementation alongside the vanilla PWA, using **Supabase
Auth + Row-Level Security** for real per-account data isolation.

## Status
Running foundation:
- Marketing landing (`/`)
- Email + password auth (`/login`) via Supabase
- Auth-gated dashboard (`/dashboard`) — lists & creates the signed-in user's
  packages from Supabase, isolated by RLS; session refresh via `middleware.js`

The remaining platform views (pre-sort, manifests, exceptions, returns, reports,
etc.) port into `app/dashboard/*` from here.

## Setup
1. Create a Supabase project; SQL Editor → run `supabase.sql`.
2. Authentication → Providers → enable **Email** (toggle off "Confirm email" for a quick pilot).
3. `cp .env.local.example .env.local` and fill **Project URL** + **anon key**.
4. `npm install` then `npm run dev` → http://localhost:3000

## Deploy
- **Vercel:** import the repo, set root to `next/`, add the two env vars. (Most native for Next.)
- **Netlify:** works via Netlify's Next runtime — set base directory `next/`, same env vars.

Only the **anon** key goes here (it's public). Never put the `service_role` key in this app.
