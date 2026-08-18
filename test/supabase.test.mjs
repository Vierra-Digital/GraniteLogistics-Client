// Tests for the Supabase data layer, against a fake PostgREST built from the real schema.
//
// The schema has never been applied to a Postgres, so the failure to worry about is a column
// this code writes that the schema does not declare -- which is exactly how the missing
// load_unit, sort_zone, presort_lane, transmitted and activity_events were found. So the fake
// parses supabase/schema-relational.sql for its column set and rejects anything else. If the
// mapping and the schema drift apart, these tests fail rather than production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---- the column set, from the schema itself ------------------------------------------
const SQL = readFileSync(new URL("../supabase/schema-relational.sql", import.meta.url), "utf8");

function parseTables(sql) {
  const tables = {};
  const re = /create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    const cols = [];
    for (const raw of m[2].split("\n")) {
      const line = raw.replace(/--.*$/, "").trim();
      if (!line) continue;
      const c = /^(\w+)\s+(?:uuid|text|jsonb|timestamptz|boolean|integer|bigserial|public\.\w+)/.exec(line);
      if (c) cols.push(c[1]);
    }
    tables[m[1]] = cols;
  }
  return tables;
}
const TABLES = parseTables(SQL);

test("the schema parses, and declares the tables the data layer writes", () => {
  for (const t of ["tenants", "packages", "package_events", "manifests", "load_units",
                   "activity_events", "workspace_settings"]) {
    assert.ok(TABLES[t] && TABLES[t].length, "no columns parsed for " + t);
  }
  // Guards against the parser silently matching nothing and the conformance check below
  // therefore passing vacuously -- the way an earlier audit in this project reported zero
  // failures because its comparison had quietly become NaN.
  assert.ok(TABLES.packages.includes("photo_pickup"));
  assert.ok(TABLES.packages.includes("load_unit"));
  assert.ok(TABLES.manifests.includes("transmitted"));
  assert.ok(TABLES.load_units.includes("weight_lb"));
});

// ---- fake PostgREST + Storage ---------------------------------------------------------
function makeSupabase() {
  const rows = { tenants: [], packages: [], package_events: [], manifests: [], load_units: [], activity_events: [], workspace_settings: [] };
  const bucket = new Map();          // storage path -> bytes
  const violations = [];             // columns written that the schema does not declare
  let seq = 0;
  let failUploads = false;
  let conflictOnce = null;           // an id to reject once, to exercise the 409 path

  // Primary keys, per the schema. PostgREST resolves a conflict against the target named by
  // on_conflict, and against the PRIMARY KEY when that parameter is absent -- so for the two
  // tables keyed by a bigserial the client never sends, omitting on_conflict means no dedupe
  // at all and every push appends another copy. Modelling that is the point: it is the whole
  // reason the on_conflict targets exist.
  const PRIMARY_KEY = {
    tenants: ["slug"],
    packages: ["uid"],
    package_events: ["id"],
    manifests: ["tenant", "id"],
    load_units: ["tenant", "id"],
    activity_events: ["id"],
    workspace_settings: ["tenant"],
  };
  const conflictKeyFor = (table, params) => {
    const target = params.find(([k]) => k === "on_conflict");
    const cols = target ? target[1].split(",") : PRIMARY_KEY[table];
    return (row) => (cols.some((c) => row[c] === undefined) ? null : cols.map((c) => String(row[c])).join("|"));
  };

  const check = (table, row) => {
    for (const k of Object.keys(row)) {
      if (!TABLES[table] || !TABLES[table].includes(k)) violations.push(table + "." + k);
    }
  };

  // Only the filter forms this code actually uses.
  const matches = (row, params) => {
    for (const [key, val] of params) {
      if (["select", "order", "limit", "on_conflict"].includes(key)) continue;
      if (val.startsWith("eq.")) { if (String(row[key]) !== val.slice(3)) return false; continue; }
      if (val === "is.null") { if (row[key] !== null && row[key] !== undefined) return false; continue; }
      if (val.startsWith("in.(")) {
        const set = val.slice(4, -1).split(",").map(decodeURIComponent);
        if (!set.includes(String(row[key]))) return false;
        continue;
      }
      throw new Error("fake PostgREST cannot evaluate filter " + key + "=" + val);
    }
    return true;
  };

  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? (typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body) : undefined;
    // 204 must have no body at all, which is what PostgREST returns for Prefer: return=minimal.
    const ok = (payload, status = 200) =>
      (status === 204 ? new Response(null, { status })
                      : new Response(payload === undefined ? "" : JSON.stringify(payload), { status }));

    // ---- Storage ----
    if (u.pathname.startsWith("/storage/v1/object/sign/")) {
      const paths = (body && body.paths) || [];
      return ok(paths.map((p) => ({ path: p, signedURL: "/object/sign/condition-photos/" + p + "?token=t" + (++seq) })));
    }
    if (u.pathname.startsWith("/storage/v1/object/")) {
      if (failUploads) return new Response("nope", { status: 500 });
      bucket.set(u.pathname.replace("/storage/v1/object/condition-photos/", ""), opts.body);
      return ok({ Key: u.pathname });
    }

    // ---- PostgREST ----
    const table = u.pathname.replace("/rest/v1/", "");
    if (!(table in rows)) return new Response(JSON.stringify({ message: "no table" }), { status: 404 });
    const params = [...u.searchParams.entries()];

    if (method === "GET") {
      let out = rows[table].filter((r) => matches(r, params));
      const order = u.searchParams.get("order");
      if (order) {
        const [col, dir] = order.split(".");
        out = out.slice().sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1));
        if (dir === "desc") out.reverse();
      }
      const limit = u.searchParams.get("limit");
      if (limit) out = out.slice(0, +limit);
      return ok(out);
    }

    if (method === "POST") {
      const incoming = Array.isArray(body) ? body : [body];
      const prefer = (opts.headers && (opts.headers.Prefer || opts.headers.prefer)) || "";
      const keyOf = conflictKeyFor(table, params);
      for (const row of incoming) {
        check(table, row);
        if (conflictOnce && table === "packages" && row.id === conflictOnce) {
          conflictOnce = null;
          return new Response(JSON.stringify({ code: "23505", message: "duplicate key" }), { status: 409 });
        }
        const key = keyOf(row);
        // A key the row cannot supply (a bigserial) can never collide, so this is an insert.
        const at = key === null ? -1 : rows[table].findIndex((r) => keyOf(r) === key);
        if (at >= 0) {
          if (prefer.includes("merge-duplicates")) rows[table][at] = { ...rows[table][at], ...row };
          else if (prefer.includes("ignore-duplicates")) continue;
          else return new Response(JSON.stringify({ code: "23505", message: "duplicate key" }), { status: 409 });
        } else {
          rows[table].push({ ...row });
        }
      }
      return ok(undefined, 201);
    }

    if (method === "PATCH") {
      check(table, body);
      for (const r of rows[table]) if (matches(r, params)) Object.assign(r, body);
      return ok(undefined, 204);
    }
    throw new Error("fake PostgREST got " + method);
  };

  return {
    rows, bucket, violations, fetchImpl,
    set failUploads(v) { failUploads = v; },
    set conflictOnce(v) { conflictOnce = v; },
  };
}

const PNG = "data:image/png;base64," + Buffer.from("fake-png-bytes").toString("base64");

async function withSupabase(fn) {
  const fake = makeSupabase();
  const realFetch = globalThis.fetch;
  const prevUrl = process.env.SUPABASE_URL, prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  globalThis.fetch = fake.fetchImpl;
  try {
    const lib = await import("../netlify/functions/_supabase.mjs");
    await fn(lib, fake);
    assert.deepEqual(fake.violations, [], "columns written that the schema does not declare");
  } finally {
    globalThis.fetch = realFetch;
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
}

// A workspace using every field the app actually stores.
const workspace = () => ({
  packages: [
    {
      uid: "11111111-1111-4111-8111-111111111111",
      id: "GL-1041", status: "Delivered", source: "API", orderRef: "#10411", barcode: "GL1041",
      carrier: "UPS", lane: "Lane 2", batchId: "BATCH-701", tracking: "1Z999AA10123456783",
      item: { description: "Sonos Arc soundbar", value: 799, weight: 18 },
      customer: { name: "Priya Raman", address: "121 Birchwood Lane", city: "Dayton", state: "OH", zip: "45402", phone: "937-555-0113" },
      customerEmail: "jane@example.com",
      photos: { pickup: PNG, delivery: PNG },
      loadUnit: "LU-9", sortZone: "454", presortLane: "Lane 2",
      promisedTs: 1893456000000,
      exception: null,
      return: { state: "Requested", ts: 1893450000000, reason: "Damaged / Defective" },
      history: [
        { stage: "Won", ts: 1893400000000, note: "Order placed by the customer." },
        { stage: "Delivered", ts: 1893456000000, note: "Delivery confirmed with final condition photo." },
      ],
      // Client-only flags: true of a device, not of a shipment.
      pendingSync: true, syncRejected: false,
    },
  ],
  manifests: [{ id: "BATCH-701", carrier: "UPS", lane: "Lane 2", ts: 1893410000000, transmitted: true, packageIds: ["GL-1041"] }],
  loadUnits: [{ id: "LU-9", zone: "454", lane: "Lane 2", weightLb: 41, ts: 1893405000000, parcels: ["GL-1041"] }],
  events: [{ ts: 1893450000000, pkgId: "GL-1041", who: "Priya Raman", kind: "return", note: "Return requested: Damaged / Defective" }],
  settings: {
    company: { name: "Granite Logistics" }, defaultCarrier: "UPS", defaultLane: "Lane 1",
    // Must not be stored: a credential and two device preferences.
    cloud: { url: "https://x", key: "granite-dev-key", provider: "supabase" },
    theme: "dark", role: "Admin", roleChosen: true,
  },
});

test("a workspace survives a write and a read unchanged", async () => {
  await withSupabase(async (sb, fake) => {
    const before = workspace();
    await sb.sbWriteState("default", before);
    const after = await sb.sbReadState("default");

    assert.equal(after.packages.length, 1);
    const p = after.packages[0], b = before.packages[0];
    for (const k of ["uid", "id", "status", "source", "orderRef", "barcode", "carrier", "lane",
                     "batchId", "tracking", "customerEmail", "loadUnit", "sortZone", "presortLane", "promisedTs"]) {
      assert.deepEqual(p[k], b[k], "field " + k + " did not survive");
    }
    assert.deepEqual(p.item, b.item);
    assert.deepEqual(p.customer, b.customer);
    assert.deepEqual(p.return, b.return);
    assert.deepEqual(p.history, b.history, "custody history did not survive");

    // Membership is derived, not stored, so it must come back identical anyway.
    assert.deepEqual(after.manifests[0].packageIds, ["GL-1041"]);
    assert.deepEqual(after.loadUnits[0].parcels, ["GL-1041"]);
    assert.equal(after.manifests[0].transmitted, true);
    assert.equal(after.loadUnits[0].weightLb, 41);
    assert.deepEqual(after.events, before.events);

    // Device-scoped settings are dropped; workspace settings are kept.
    assert.equal(after.settings.company.name, "Granite Logistics");
    assert.equal(after.settings.cloud, undefined, "an api key was stored in the workspace");
    assert.equal(after.settings.theme, undefined);

    // Client-only sync flags must not come back as though the server had an opinion.
    assert.equal(p.pendingSync, undefined);
    assert.equal(p.syncRejected, undefined);
    void fake;
  });
});

test("condition photos go to Storage as bytes, and come back as expiring signed URLs", async () => {
  await withSupabase(async (sb, fake) => {
    await sb.sbWriteState("default", workspace());

    // The bytes are in the bucket, at a path scoped by tenant and parcel.
    assert.deepEqual([...fake.bucket.keys()].sort(), ["default/GL-1041/delivery.png", "default/GL-1041/pickup.png"]);
    // The row holds the path, never the data URL. This is the localStorage ceiling fix: two
    // photos as data URLs are ~220,000 characters, and the row now costs ~60.
    const row = fake.rows.packages[0];
    assert.equal(row.photo_pickup, "default/GL-1041/pickup.png");
    assert.ok(!String(row.photo_pickup).startsWith("data:"));
    assert.ok(!JSON.stringify(fake.rows.packages).includes("data:image"), "a data URL was stored in a row");

    const after = await sb.sbReadState("default");
    assert.match(after.packages[0].photos.pickup, /\/object\/sign\/condition-photos\/default\/GL-1041\/pickup\.png\?token=/);
    assert.equal(sb.PHOTO_URL_TTL, 600, "signed photo URLs must expire");
  });
});

test("a signed URL pushed back by a client is stored as its path, not as a URL", async () => {
  await withSupabase(async (sb) => {
    await sb.sbWriteState("default", workspace());
    const pulled = await sb.sbReadState("default");
    // The client pulls, changes nothing about the photo, and pushes the whole workspace back.
    await sb.sbWriteState("default", { ...pulled, settings: {} });
    const again = await sb.sbReadState("default");
    assert.match(again.packages[0].photos.pickup, /\/object\/sign\/condition-photos\//);
    assert.equal(sb.storagePathOf(pulled.packages[0].photos.pickup), "default/GL-1041/pickup.png");
  });
});

test("a photo whose upload fails costs the photo, never the parcel", async () => {
  await withSupabase(async (sb, fake) => {
    fake.failUploads = true;
    await sb.sbWriteState("default", workspace());
    const after = await sb.sbReadState("default");
    assert.equal(after.packages.length, 1, "the parcel was lost with its photo");
    assert.equal(after.packages[0].photos.pickup, undefined);
    assert.equal(after.packages[0].id, "GL-1041");
  });
});

test("pushing the same workspace twice does not duplicate custody history", async () => {
  await withSupabase(async (sb, fake) => {
    await sb.sbWriteState("default", workspace());
    await sb.sbWriteState("default", workspace());
    await sb.sbWriteState("default", workspace());
    assert.equal(fake.rows.packages.length, 1);
    assert.equal(fake.rows.package_events.length, 2, "history was appended again on re-push");
    assert.equal(fake.rows.activity_events.length, 1);
    const after = await sb.sbReadState("default");
    assert.equal(after.packages[0].history.length, 2);
  });
});

test("a parcel absent from a push is soft-deleted, and stays gone on the next read", async () => {
  await withSupabase(async (sb, fake) => {
    await sb.sbWriteState("default", workspace());
    // Same workspace with the parcel removed -- what the client sends after a delete.
    await sb.sbWriteState("default", { ...workspace(), packages: [] });

    assert.equal(fake.rows.packages.length, 1, "the row was removed rather than tombstoned");
    assert.ok(fake.rows.packages[0].deleted_at, "deleted_at was not set");
    const after = await sb.sbReadState("default");
    assert.deepEqual(after.packages, [], "a deleted parcel came back");
  });
});

test("two orders racing onto one id cannot share it: the 409 is taken as the answer", async () => {
  await withSupabase(async (sb, fake) => {
    await sb.sbWriteState("default", workspace());          // GL-1041 exists
    fake.conflictOnce = "GL-1042";                          // somebody takes it first

    const build = (state) => {
      let max = 1040;
      for (const p of state.packages) { const m = /GL-(\d+)/.exec(p.id || ""); if (m) max = Math.max(max, +m[1]); }
      const id = "GL-" + (max + 1);
      return { id, barcode: id.replace(/-/g, ""), status: "Won", item: {}, customer: {}, photos: {}, history: [{ stage: "Won", ts: 1893460000000 }] };
    };
    const r = await sb.sbAppendOrder("default", build);
    assert.equal(r.repaired, 1, "the conflict was not detected");
    assert.equal(r.order.id, "GL-1042");
    assert.equal(r.order.barcode, "GL1042");
    assert.ok(!r.unverified);
    const ids = fake.rows.packages.map((p) => p.id).sort();
    assert.deepEqual(ids, ["GL-1041", "GL-1042"]);
    assert.equal(new Set(ids).size, ids.length, "two parcels ended up sharing an id");
  });
});

test("an empty workspace reads as the empty shape rather than throwing", async () => {
  await withSupabase(async (sb) => {
    const s = await sb.sbReadState("brand-new");
    assert.deepEqual(s.packages, []);
    assert.deepEqual(s.manifests, []);
    assert.deepEqual(s.loadUnits, []);
    assert.deepEqual(s.events, []);
    assert.deepEqual(s.settings, {});
  });
});

test("without both credentials the provider stays Netlify Blobs", async () => {
  const prevUrl = process.env.SUPABASE_URL, prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const { supabaseConfigured } = await import("../netlify/functions/_supabase.mjs");
    assert.equal(supabaseConfigured(), false);
    process.env.SUPABASE_URL = "https://project.supabase.co";
    assert.equal(supabaseConfigured(), false, "a url alone must not switch provider");
    process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
    assert.equal(supabaseConfigured(), true);
  } finally {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test("the migration transform only writes columns the schema declares", async () => {
  const { transform } = await import("../scripts/migrate-to-supabase.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const out = mkdtempSync(tmpdir() + "/gl-schema-");

  const ws = workspace();
  // The transform reads photos as data URLs off p.photos and history off p.history.
  const { sql } = transform({ ...ws, packages: ws.packages }, out, "default");

  const seen = [];
  const re = /insert into public\.(\w+) \(([^)]*)\)/g;
  let m;
  while ((m = re.exec(sql))) {
    const table = m[1];
    for (const col of m[2].split(",").map((c) => c.trim())) {
      if (!TABLES[table] || !TABLES[table].includes(col)) seen.push(table + "." + col);
    }
  }
  assert.deepEqual(seen, [], "the transform writes columns that do not exist");
  // And that it covered every table the live data layer does, so a migrated workspace is not
  // quietly missing its activity log or its settings.
  const tables = [...sql.matchAll(/insert into public\.(\w+)/g)].map((x) => x[1]);
  for (const t of ["tenants", "packages", "package_events", "manifests", "load_units",
                   "activity_events", "workspace_settings"]) {
    assert.ok(tables.includes(t), "the transform never writes " + t);
  }
});
