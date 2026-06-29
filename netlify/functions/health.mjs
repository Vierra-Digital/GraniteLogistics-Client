// Open health check.
import { json } from "./_lib.mjs";

export default async () =>
  json({ ok: true, service: "granite-logistics", runtime: "netlify-functions", dbConfigured: !!process.env.DATABASE_URL, time: new Date().toISOString() });

export const config = { path: "/api/health" };
