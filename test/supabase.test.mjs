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

// Every UNIQUE constraint, per table. The fake enforces all of them, not only the one named
// by on_conflict: an insert that upserts on the primary key can still violate a different
// unique constraint, which is exactly how an unstable uid stayed invisible until it 409'd on
// the second sync.
function parseUniques(sql) {
  const out = {};
  const re = /create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    const list = [];
    for (const raw of m[2].split("\n")) {
      const line = raw.replace(/--.*$/, "").trim();
      const u = /^unique \(([^)]*)\)/.exec(line);
      if (u) list.push(u[1].split(",").map((c) => c.trim()));
      const pk = /^primary key \(([^)]*)\)/.exec(line);
      if (pk) list.push(pk[1].split(",").map((c) => c.trim()));
      const inline = /^(\w+)\s+\S+.*\bunique\b/.exec(line);
      if (inline) list.push([inline[1]]);
    }
    out[m[1]] = list;
  }
  return out;
}

// Foreign keys, per table: { column: [table, column] }. A real database rejects a row whose
// parent is missing, which is the only thing standing between "we forgot to create the tenant
// row" and a first sync that fails on every insert.
function parseForeignKeys(sql) {
  const out = {};
  const re = /create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    out[m[1]] = {};
    for (const raw of m[2].split("\n")) {
      const line = raw.replace(/--.*$/, "").trim();
      const fk = /^(\w+)\s+.*references public\.(\w+)\s*\((\w+)\)/.exec(line);
      if (fk) out[m[1]][fk[1]] = [fk[2], fk[3]];
    }
  }
  return out;
}

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
const UNIQUES = parseUniques(SQL);
const FOREIGN_KEYS = parseForeignKeys(SQL);

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
  // The constraints the fake enforces have to have actually been found.
  assert.ok(UNIQUES.packages.some((u) => u.join() === "tenant,id"), "unique (tenant, id) not parsed");
  assert.ok(UNIQUES.package_events.some((u) => u.join() === "package_uid,stage,at"));
});

// ---- fake PostgREST + Storage ---------------------------------------------------------
function makeSupabase() {
  const rows = { tenants: [], packages: [], package_events: [], manifests: [], load_units: [], activity_events: [], workspace_settings: [] };
  const bucket = new Map();          // storage path -> bytes
  const violations = [];             // columns written that the schema does not declare
  let seq = 0;
  let failUploads = false;
  let failDeletes = false;
  let rateLimitSigns = 0;      // answer this many sign requests with 429 before succeeding
  let signRequests = 0;
  const signBatchSizes = [];   // how many paths each sign request asked for
  let uploadsInFlight = 0, maxUploadsInFlight = 0;
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
      if (["select", "order", "limit", "offset", "on_conflict"].includes(key)) continue;
      if (val.startsWith("eq.")) { if (String(row[key]) !== val.slice(3)) return false; continue; }
      if (val === "is.null") { if (row[key] !== null && row[key] !== undefined) return false; continue; }
      if (val.startsWith("in.(")) {
        const set = val.slice(4, -1).split(",").map(decodeURIComponent);
        if (!set.includes(String(row[key]))) return false;
        continue;
      }
      if (val.startsWith("neq.")) { if (String(row[key]) === decodeURIComponent(val.slice(4))) return false; continue; }
      // Timestamp comparisons, kept for any future range filter.
      if (val.startsWith("lt.") || val.startsWith("gte.")) {
        const bound = decodeURIComponent(val.replace(/^(lt|gte)\./, ""));
        const mine = row[key];
        if (mine === null || mine === undefined) return false;
        const cmp = String(mine) < String(bound);
        if (val.startsWith("lt.") ? !cmp : cmp) return false;
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
      signRequests++;
      // Storage rate limits, and a read asks for every photo in the workspace. Modelled because
      // returning {} on a 429 used to drop every photo from the response.
      if (rateLimitSigns > 0) {
        rateLimitSigns--;
        return new Response(JSON.stringify({ statusCode: "429", error: "too_many_connections" }), { status: 429 });
      }
      const paths = (body && body.paths) || [];
      signBatchSizes.push(paths.length);
      // A path with no object cannot be signed, which is how the real service answers and what
      // makes "a deleted photo cannot be signed again" a meaningful check.
      return ok(paths.map((p) => (bucket.has(p)
        ? { path: p, signedURL: "/object/sign/condition-photos/" + p + "?token=t" + (++seq) }
        : { path: p, error: "Object not found", signedURL: null })));
    }
    // Deletion takes a body of prefixes rather than a path in the URL. Modelled properly
    // because it actually has to empty the bucket: a fake that returns 200 and keeps the bytes
    // would report a privacy promise as kept while leaving the file exactly where it was.
    if (method === "DELETE" && u.pathname === "/storage/v1/object/condition-photos") {
      if (failDeletes) return new Response("storage unavailable", { status: 503 });
      const prefixes = (body && body.prefixes) || [];
      let removed = 0;
      for (const key of [...bucket.keys()]) {
        if (prefixes.some((p) => key === p || key.startsWith(p.replace(/\/?$/, "/")))) {
          bucket.delete(key);
          removed++;
        }
      }
      return ok(prefixes.map((p) => ({ name: p })), removed || prefixes.length ? 200 : 200);
    }
    if (u.pathname.startsWith("/storage/v1/object/")) {
      if (failUploads) return new Response("nope", { status: 500 });
      // Track concurrency: the bound on simultaneous uploads is what keeps Storage from rate
      // limiting the signing that follows, and it is invisible unless something counts.
      uploadsInFlight++;
      if (uploadsInFlight > maxUploadsInFlight) maxUploadsInFlight = uploadsInFlight;
      await new Promise((r) => setTimeout(r, 1));
      uploadsInFlight--;
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
      // Embedded resources: select=*,package_events(stage,note,at) nests the children of each
      // row via the foreign key, which is what replaced a uid-per-parcel URL filter.
      const select = u.searchParams.get("select") || "*";
      const embed = /(\w+)\(([^)]*)\)/.exec(select);
      if (embed) {
        const [, child, colList] = embed;
        const fk = Object.entries(FOREIGN_KEYS[child] || {}).find(([, [t]]) => t === table);
        if (!fk) throw new Error("fake cannot embed " + child + " in " + table + ": no foreign key");
        const [fkCol, [, parentCol]] = fk;
        const cols = colList.split(",").map((c) => c.trim()).filter(Boolean);
        // Reversed deliberately. PostgREST promises no order for an embedded resource, and
        // returning them in insertion order let a real bug through: custody history came back
        // newest-first and the timeline drew backwards. A fake that is kinder than the service
        // is a fake that hides things.
        out = out.map((r) => ({
          ...r,
          [child]: rows[child]
            .filter((c) => String(c[fkCol]) === String(r[parentCol]))
            .map((c) => (cols.length ? Object.fromEntries(cols.map((k) => [k, c[k]])) : c))
            .reverse(),
        }));
      }

      const offset = +(u.searchParams.get("offset") || 0);
      const limit = u.searchParams.get("limit");
      if (offset) out = out.slice(offset);
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
        for (const [col, [pTable, pCol]] of Object.entries(FOREIGN_KEYS[table] || {})) {
          if (row[col] === undefined || row[col] === null) continue;
          if (!rows[pTable] || !rows[pTable].some((r) => String(r[pCol]) === String(row[col]))) {
            return new Response(JSON.stringify({ code: "23503",
              message: 'insert or update on table "' + table + '" violates foreign key constraint on ' + col }), { status: 409 });
          }
        }
        const key = keyOf(row);
        // A key the row cannot supply (a bigserial) can never collide, so this is an insert.
        const at = key === null ? -1 : rows[table].findIndex((r) => keyOf(r) === key);
        if (at < 0) {
          // Inserting: every OTHER unique constraint still applies. Postgres does not care
          // which one you named in on_conflict.
          for (const cols of (UNIQUES[table] || [])) {
            if (cols.join() === (u.searchParams.get("on_conflict") || "").split(",").map((c) => c.trim()).join()) continue;
            if (cols.some((c) => row[c] === undefined || row[c] === null)) continue;
            const clash = rows[table].some((r) => !r.deleted_at && cols.every((c) => String(r[c]) === String(row[c])));
            if (clash) {
              return new Response(JSON.stringify({ code: "23505",
                message: 'duplicate key value violates unique constraint "' + table + "_" + cols.join("_") + '_key"' }), { status: 409 });
            }
          }
        }
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
    set failDeletes(v) { failDeletes = v; },
    set rateLimitSigns(v) { rateLimitSigns = v; },
    get signRequests() { return signRequests; },
    get signBatchSizes() { return signBatchSizes; },
    get maxUploadsInFlight() { return maxUploadsInFlight; },
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

test("a parcel an ops client created itself survives a second push", async () => {
  await withSupabase(async (sb, fake) => {
    // No uid: uid is minted server-side by the order paths, so anything an operator creates
    // in the app arrives without one. It must still map to exactly one row every push.
    const ws = {
      packages: [{ id: "GL-1050", status: "Won", item: { description: "Pallet" }, customer: { city: "Dayton" },
                   photos: {}, history: [{ stage: "Won", ts: 1893400000000 }] }],
      manifests: [], loadUnits: [], events: [], settings: {},
    };
    await sb.sbWriteState("default", ws);
    const first = fake.rows.packages[0].uid;
    await sb.sbWriteState("default", ws);
    await sb.sbWriteState("default", ws);
    assert.equal(fake.rows.packages.length, 1, "each push inserted another row");
    assert.equal(fake.rows.packages[0].uid, first, "the row's identity changed between pushes");
    assert.equal(fake.rows.package_events.length, 1);
    const after = await sb.sbReadState("default");
    assert.equal(after.packages.length, 1);
    assert.equal(after.packages[0].id, "GL-1050");
  });
});

test("the same parcel identity yields the same uid in the data layer and the migration SQL", async () => {
  const { stableUid } = await import("../netlify/functions/_supabase.mjs");
  const { transform } = await import("../scripts/migrate-to-supabase.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const uid = stableUid("default", "GL-1041");
  assert.match(uid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(stableUid("default", "GL-1041"), uid, "not deterministic");
  assert.notEqual(stableUid("acme", "GL-1041"), uid, "two tenants collided on one uid");

  // If the migration SQL seeded a different uid, the first sync after migrating would insert
  // a second row for the same parcel and hit unique (tenant, id).
  const { sql } = transform(workspace(), mkdtempSync(tmpdir() + "/gl-uid-"), "default");
  assert.ok(sql.includes(uid), "the transform does not seed the uid the data layer derives");
});

test("an operator-created parcel does not come back looking server-created", async () => {
  // mergePushedPackages reads the presence of `uid` as "the server made this, so an ops client
  // pushing a stale snapshot must not delete it". If a derived row identity leaked back as
  // that uid, every parcel would qualify and a local Reset could never clear the workspace.
  const { mergePushedPackages } = await import("../netlify/functions/_lib.mjs");
  await withSupabase(async (sb) => {
    await sb.sbWriteState("default", {
      packages: [
        { id: "GL-1050", status: "Won", item: {}, customer: {}, photos: {}, history: [] },
        { id: "GL-1051", status: "Won", item: {}, customer: {}, photos: {}, history: [],
          uid: "22222222-2222-4222-8222-222222222222" },   // a server-minted order
      ],
      manifests: [], loadUnits: [], events: [], settings: {},
    });
    const after = await sb.sbReadState("default");
    const operatorMade = after.packages.find((p) => p.id === "GL-1050");
    const serverMade = after.packages.find((p) => p.id === "GL-1051");
    assert.equal(operatorMade.uid, undefined, "an operator-created parcel came back with a uid");
    assert.equal(serverMade.uid, "22222222-2222-4222-8222-222222222222", "a server order lost its uid");

    // So a client that cleared its local state clears the workspace, while a server-created
    // order it has never seen survives.
    const merged = mergePushedPackages(after.packages, [], []);
    assert.deepEqual(merged.packages.map((p) => p.id), ["GL-1051"]);
  });
});

test("the real order builders work with the thin state sbAppendOrder hands them", async () => {
  // sbAppendOrder passes { packages: [{id}] } rather than a whole workspace, because numbering
  // the next id is all a builder needs. If one ever starts reading more, this fails here rather
  // than in production.
  const { makeOrder } = await import("../netlify/functions/_lib.mjs");
  const thin = { packages: [{ id: "GL-1041" }, { id: "GL-1042" }] };
  const o = makeOrder({ item: "Pallet", name: "A", city: "Dayton" }, thin);
  assert.equal(o.id, "GL-1043");
  assert.equal(o.barcode, "GL1043");

  await withSupabase(async (sb, fake) => {
    const r = await sb.sbAppendOrder("default", (state) => makeOrder({ item: "Crate" }, state));
    assert.equal(r.order.id, "GL-1041");
    assert.ok(r.order.uid, "a server-created order must carry an order uid");
    assert.equal(fake.rows.packages[0].order_uid, r.order.uid);
    assert.equal(fake.rows.package_events.length, 1, "the Won entry was not recorded");
    assert.equal(fake.rows.package_events[0].package_uid, fake.rows.packages[0].uid,
      "the custody entry points at something other than its parcel's row");
  });
});

// ---- schema integrity ------------------------------------------------------------------
// Static checks for the failures that only appear against a real Postgres. There is no psql,
// Docker or Supabase CLI here, so this is the closest thing to running it -- and each of these
// is a mistake the file actually contained.

test("the schema is safe to run twice", () => {
  // The realistic first application fails part-way and gets re-run. Every statement therefore
  // has to be idempotent, and two kinds are not by default: CREATE TYPE (no IF NOT EXISTS in
  // Postgres) and CREATE POLICY (likewise).
  const enums = [...SQL.matchAll(/^create type/gm)];
  assert.equal(enums.length, 0, "a bare CREATE TYPE will error on a re-run; guard it in a DO block");

  const created = [...SQL.matchAll(/^create policy "([^"]+)" *\n? *on (public\.\w+)/gm)]
    .map((m) => m[1] + " on " + m[2].trim());
  const dropped = new Set([...SQL.matchAll(/^drop policy if exists "([^"]+)" on (public\.\w+);/gm)]
    .map((m) => m[1] + " on " + m[2].trim()));
  assert.ok(created.length >= 10, "policies were not parsed: " + created.length);
  for (const c of created) assert.ok(dropped.has(c), "policy is not dropped before create: " + c);

  for (const kw of ["create table ", "create index ", "create extension "]) {
    const bare = [...SQL.matchAll(new RegExp("^" + kw + "(?!if not exists)", "gm"))];
    assert.equal(bare.length, 0, kw.trim() + " without IF NOT EXISTS will error on a re-run");
  }
});

test("dollar-quoted function bodies are intact", () => {
  // A lost $$ turns the rest of the file into one string literal, and Postgres reports it
  // hundreds of lines away from the cause. It has happened three times in this project, every
  // time to a JS string replacement, where $$ means an escaped $.
  //
  // Counting pairs for evenness is not enough and this test used to do exactly that: when a
  // replacement eats BOTH dollars of a pair the count drops by two and stays even. That is the
  // real failure mode -- `as $$ ... $$;` becoming `as $ ... $;` -- so check the shapes.
  // Shapes, not counts. Counting where each body opens and closes is fragile -- one helper
  // here opens and closes on a single line -- but a lone $ where a $$ belongs is unambiguous.
  assert.ok(!/\bas \$(?!\$)/.test(SQL), "a function body opens with a single $ instead of $$");
  assert.ok(!/(?<!\$)\$;/.test(SQL), "a function body closes with a single $ instead of $$");
  assert.ok(!/\bdo \$(?!\$)/.test(SQL), "a DO block opens with a single $ instead of $$");
  const opens = (SQL.match(/\$\$/g) || []).length;
  assert.ok(opens >= 8, "dollar quoting was not found, so this proves nothing: " + opens);
  assert.equal(opens % 2, 0, "unbalanced $$ quoting");
});

test("no unique constraint silently relies on NULLs comparing equal", () => {
  // Postgres treats NULLs as distinct, so a unique constraint containing a nullable column
  // deduplicates nothing for rows that leave it empty -- and ON CONFLICT against it appends a
  // fresh copy every time. NULLS NOT DISTINCT is the fix, and needs saying explicitly.
  const nullable = {};
  for (const [table, cols] of Object.entries(TABLES)) {
    const block = new RegExp("create table if not exists public\\." + table + "\\s*\\(([\\s\\S]*?)\\n\\);").exec(SQL)[1];
    nullable[table] = cols.filter((c) => {
      const line = block.split("\n").find((l) => l.trim().startsWith(c + " "));
      return line && !/not null|primary key/.test(line);
    });
  }
  for (const [table, list] of Object.entries(UNIQUES)) {
    for (const cols of list) {
      const block = new RegExp("create table if not exists public\\." + table + "\\s*\\(([\\s\\S]*?)\\n\\);").exec(SQL)[1];
      const decl = block.split("\n").find((l) => l.includes("unique") && cols.every((c) => l.includes(c)));
      if (!decl || cols.length < 2) continue;
      const risky = cols.filter((c) => (nullable[table] || []).includes(c));
      if (risky.length) {
        assert.match(decl, /nulls not distinct/,
          table + " unique (" + cols.join(", ") + ") includes nullable " + risky.join(", ") +
          " but does not say NULLS NOT DISTINCT");
      }
    }
  }
});

test("every foreign key points at a table and column that exist", () => {
  const refs = [...SQL.matchAll(/references public\.(\w+)\s*\((\w+)\)/g)];
  assert.ok(refs.length >= 8, "foreign keys were not parsed: " + refs.length);
  for (const [, table, col] of refs) {
    assert.ok(TABLES[table], "foreign key references missing table " + table);
    assert.ok(TABLES[table].includes(col), "foreign key references missing column " + table + "." + col);
  }
});

test("policies and indexes only name tables the schema declares", () => {
  const named = [
    ...[...SQL.matchAll(/^create policy "[^"]+"\s*\n?\s*on public\.(\w+)/gm)].map((m) => m[1]),
    ...[...SQL.matchAll(/^create index if not exists \w+ on public\.(\w+)/gm)].map((m) => m[1]),
    ...[...SQL.matchAll(/^alter table public\.(\w+)\s+enable row level security/gm)].map((m) => m[1]),
  ];
  assert.ok(named.length >= 20, "nothing parsed: " + named.length);
  for (const t of new Set(named)) assert.ok(TABLES[t], "references undeclared table " + t);

  // Every table the data layer writes must have RLS on. Without it the anon key reads the lot.
  const rls = new Set([...SQL.matchAll(/^alter table public\.(\w+)\s+enable row level security/gm)].map((m) => m[1]));
  for (const t of Object.keys(TABLES)) {
    if (t === "tenants") continue;   // slugs only, no business data
    assert.ok(rls.has(t), "row level security is not enabled on " + t);
  }
});

test("the helper functions a policy calls are defined before it", () => {
  for (const fn of ["my_role", "my_tenant", "effective_role"]) {
    const defined = SQL.indexOf("function public." + fn);
    assert.ok(defined > 0, fn + " is never defined");
    const firstUse = SQL.indexOf("public." + fn + "()", SQL.indexOf("create policy"));
    if (firstUse > 0) assert.ok(defined < firstUse, fn + " is used by a policy before it is defined");
  }
});

test("a parcel that changed comes back changed", async () => {
  // The upsert has to MERGE. With ignore-duplicates an existing row is never updated, so
  // advancing a parcel through the custody chain would appear to work and persist nothing --
  // the single worst failure available here, and it looks identical to success from the client.
  await withSupabase(async (sb) => {
    await sb.sbWriteState("default", workspace());

    const pulled = await sb.sbReadState("default");
    const p = pulled.packages[0];
    p.status = "OutforDelivery";
    p.carrier = "FedEx";
    p.batchId = "BATCH-702";
    p.exception = { type: "Address Issue", note: "Suite number missing" };
    p.history = p.history.concat([{ stage: "OutforDelivery", ts: 1893460000000, note: "On the vehicle." }]);
    await sb.sbWriteState("default", { ...pulled, packages: [p] });

    const after = (await sb.sbReadState("default")).packages[0];
    assert.equal(after.status, "OutforDelivery", "a status change did not persist");
    assert.equal(after.carrier, "FedEx");
    assert.equal(after.batchId, "BATCH-702");
    assert.deepEqual(after.exception, { type: "Address Issue", note: "Suite number missing" });
    assert.equal(after.history.length, 3, "the new custody entry was not appended");
    assert.equal(after.history.at(-1).stage, "OutforDelivery");
  });
});

test("a manifest handed to a carrier stays handed over", async () => {
  // transmitted is set after the manifest exists, so this row has to update too, not just
  // insert. Same failure shape as a parcel status that never persists.
  await withSupabase(async (sb) => {
    const ws = workspace();
    ws.manifests[0].transmitted = false;
    await sb.sbWriteState("default", ws);
    assert.equal((await sb.sbReadState("default")).manifests[0].transmitted, undefined);

    const pulled = await sb.sbReadState("default");
    pulled.manifests[0].transmitted = true;
    pulled.manifests[0].lane = "Lane 4";
    await sb.sbWriteState("default", pulled);

    const after = await sb.sbReadState("default");
    assert.equal(after.manifests[0].transmitted, true, "transmitting a manifest did not persist");
    assert.equal(after.manifests[0].lane, "Lane 4");
  });
});

test("the tenant row exists before anything references it", async () => {
  await withSupabase(async (sb, fake) => {
    await sb.sbWriteState("acme", workspace());
    assert.deepEqual(fake.rows.tenants.map((t) => t.slug), ["acme"]);
    // And the same for the single-order path, which is reached before any push on a new tenant.
    await sb.sbAppendOrder("globex", () => ({
      id: "GL-1041", barcode: "GL1041", status: "Won", item: {}, customer: {}, photos: {},
      history: [{ stage: "Won", ts: 1893400000000 }],
    }));
    assert.ok(fake.rows.tenants.some((t) => t.slug === "globex"), "an order created a parcel with no tenant row");
  });
});

test("two pushes inside one millisecond still record the deletion", async () => {
  // This started as a flaky test. The deletion was found by comparing timestamps, so when two
  // pushes landed in the same millisecond the surviving rows carried a stamp equal to -- not
  // less than -- the push in progress, and the removed parcel quietly stayed alive. A per-push
  // token has no granularity to lose.
  await withSupabase(async (sb, fake) => {
    const two = { ...workspace(), packages: [
      { id: "GL-3001", status: "Won", item: {}, customer: {}, photos: {}, history: [] },
      { id: "GL-3002", status: "Won", item: {}, customer: {}, photos: {}, history: [] },
    ] };
    const one = { ...two, packages: two.packages.slice(0, 1) };

    // Same tick: no await between them that could advance the clock.
    await Promise.all([sb.sbWriteState("default", two), sb.sbWriteState("default", two)]);
    await sb.sbWriteState("default", one);

    const after = await sb.sbReadState("default");
    assert.deepEqual(after.packages.map((p) => p.id), ["GL-3001"], "the removed parcel survived");
    const gone = fake.rows.packages.find((r) => r.id === "GL-3002");
    assert.ok(gone.deleted_at, "GL-3002 was not soft-deleted");
  });
});

test("custody history comes back oldest first, whatever order the rows arrive in", async () => {
  // The app draws this as a timeline and orderCreatedAt falls back to history[0].ts, so the
  // order is load-bearing. The fake hands embedded rows back reversed, matching the fact that
  // PostgREST promises nothing about their order.
  await withSupabase(async (sb) => {
    await sb.sbWriteState("default", { ...workspace(), packages: [{
      id: "GL-4001", status: "Delivered", item: {}, customer: {}, photos: {},
      history: [
        { stage: "Won", ts: 1893400000000, note: "Order placed." },
        { stage: "Intake", ts: 1893410000000 },
        { stage: "PickedUp", ts: 1893420000000 },
        { stage: "Delivered", ts: 1893456000000, note: "Delivered." },
      ],
    }] });
    const p = (await sb.sbReadState("default")).packages[0];
    assert.deepEqual(p.history.map((h) => h.stage), ["Won", "Intake", "PickedUp", "Delivered"]);
    assert.deepEqual(p.history.map((h) => h.ts), [...p.history.map((h) => h.ts)].sort((a, b) => a - b));
    assert.equal(p.history[0].note, "Order placed.", "the first entry is the oldest one");
  });
});

test("forgetting a parcel's photos removes the bytes, not just the reference", async () => {
  // The migration turned a deletion into a dangling reference. Clearing photo_pickup used to BE
  // the deletion, because the image was the data URL in the record; with Storage it only drops
  // the pointer and the file stays in the bucket at a predictable path. account.mjs promises the
  // photos are removed when somebody closes their account, so the objects have to go too.
  await withSupabase(async (sb, fake) => {
    const lib = await import("../netlify/functions/_lib.mjs");
    const PNG = "data:image/png;base64," + Buffer.from("bytes").toString("base64");
    await sb.sbWriteState("default", {
      ...workspace(),
      packages: [{ id: "GL-8001", status: "Delivered", item: {}, customer: {}, history: [],
                   customerEmail: "closing@example.com", photos: { pickup: PNG, delivery: PNG } }],
    });
    assert.equal(fake.bucket.size, 2, "two objects should have been uploaded");

    const pulled = await sb.sbReadState("default");
    const parcel = pulled.packages[0];

    // Clearing the columns alone leaves the bucket untouched -- the bug this covers.
    await sb.sbWriteState("default", { ...pulled, packages: [{ ...parcel, photos: {} }] });
    assert.equal(fake.bucket.size, 2, "clearing the reference should not have removed the bytes");

    const r = await lib.forgetPhotos([parcel]);
    assert.equal(r.provider, "supabase");
    assert.equal(r.removed, 2, "reported: " + JSON.stringify(r));
    assert.equal(fake.bucket.size, 0, "the objects are still in the bucket");
  });
});

test("a signed URL round-trips to the path it was minted for", async () => {
  const { photoPathOf, storagePathOf } = await import("../netlify/functions/_supabase.mjs");
  // What a caller actually holds after a read is a signed URL, so deletion has to work from one.
  const url = "https://p.supabase.co/storage/v1/object/sign/condition-photos/default/GL-1/pickup.webp?token=abc";
  assert.equal(storagePathOf(url), "default/GL-1/pickup.webp");
  assert.equal(photoPathOf(url), "default/GL-1/pickup.webp");
  // A bare path passes through; a data URL was never stored and must not be mistaken for one.
  assert.equal(photoPathOf("default/GL-1/pickup.webp"), "default/GL-1/pickup.webp");
  assert.equal(photoPathOf("data:image/png;base64,AAAA"), null);
  assert.equal(photoPathOf(""), null);
  assert.equal(photoPathOf(undefined), null);
  // A URL for some other bucket is not ours to delete.
  assert.equal(photoPathOf("https://p.supabase.co/storage/v1/object/sign/other-bucket/x.webp?token=abc"), null);
});

test("forgetting photos on Netlify Blobs is a no-op, not an error", async () => {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const lib = await import("../netlify/functions/_lib.mjs");
    const r = await lib.forgetPhotos([{ photos: { pickup: "data:image/png;base64,AAAA" } }]);
    assert.equal(r.provider, "blobs");
    assert.equal(r.ok, true);
    assert.equal(r.removed, 0);
  } finally {
    if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
    if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  }
});

test("a cleanup that fails is reported as failed, not as done", async () => {
  // The response text differs on this: one version tells the customer their photos are removed.
  // Saying that when the objects are still there is the kind of quiet inaccuracy nobody finds.
  await withSupabase(async (sb, fake) => {
    const lib = await import("../netlify/functions/_lib.mjs");
    const PNG = "data:image/png;base64," + Buffer.from("bytes").toString("base64");
    await sb.sbWriteState("default", {
      ...workspace(),
      packages: [{ id: "GL-8002", status: "Delivered", item: {}, customer: {}, history: [],
                   photos: { pickup: PNG } }],
    });
    const parcel = (await sb.sbReadState("default")).packages[0];

    fake.failDeletes = true;
    const r = await lib.forgetPhotos([parcel]);
    assert.equal(r.ok, false, "a 503 from storage was reported as success");
    assert.equal(r.removed, 0);
    assert.equal(r.attempted, 1, "it should say what it tried");
    assert.equal(fake.bucket.size, 1, "the object is still there, which is the point");
  });
});

// ---- account closure, in the shape production actually runs ----------------------------
//
// Auth on Netlify Blobs, workspaces on Supabase. Nothing else tests that combination, and it
// is the only place the two providers have to cooperate: the closure reads the workspace from
// Postgres, scrubs the recipient out of it, and then has to reach into Storage for the photos.
test("closing an account deletes the condition photos from Storage", async () => {
  const { mock } = await import("node:test");
  const users = new Map();
  const store = (name) => ({
    async get(key, opts) {
      const v = users.get(name + ":" + key);
      return v === undefined ? null : (opts && opts.type === "json" ? JSON.parse(v) : v);
    },
    async setJSON(key, value) { users.set(name + ":" + key, JSON.stringify(value)); },
    async set(key, value) { users.set(name + ":" + key, value); },
    async delete(key) { users.delete(name + ":" + key); },
    async list() { return { blobs: [], directories: [] }; },
  });
  mock.module("@netlify/blobs", { exports: { getStore: ({ name }) => store(name) } });

  process.env.GL_AUTH_SECRET = "closure-test-secret";
  const auth = await import("../netlify/functions/_auth.mjs");
  const accountFn = (await import("../netlify/functions/account.mjs")).default;

  await withSupabase(async (sb, fake) => {
    const email = "closing@example.com";
    await store("granite-users").setJSON(email, {
      email, name: "Closing Customer", role: "Customer", salt: "s", hash: "h",
      createdAt: new Date(1893400000000).toISOString(),
    });

    const PNG = "data:image/png;base64," + Buffer.from("doorway-photo").toString("base64");
    await sb.sbWriteState("default", {
      packages: [{
        id: "GL-9001", status: "Delivered", item: { description: "Delivered parcel" },
        customer: { name: "Closing Customer", address: "1 Doorway Ln", city: "Dayton", state: "OH", zip: "45402", phone: "937-555-0100" },
        customerEmail: email,
        photos: { pickup: PNG, delivery: PNG },
        history: [{ stage: "Won", ts: 1893400000000 }, { stage: "Delivered", ts: 1893456000000 }],
      }],
      manifests: [], loadUnits: [], events: [], settings: {},
    });
    assert.equal(fake.bucket.size, 2, "two photos should be in the bucket to start");

    const token = auth.sign({ email, name: "Closing Customer", role: "Customer", iat: Date.now(), exp: Date.now() + 60000 });
    const res = await accountFn(new Request("https://x/api/account", {
      method: "DELETE", headers: { authorization: "Bearer " + token },
    }));
    const j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j));
    assert.equal(j.ordersAnonymised, 1);
    assert.equal(j.photosDeleted, 2, "the closure did not delete the photos: " + JSON.stringify(j));
    assert.match(j.note, /photos removed/i);

    // The bytes, not just the columns.
    assert.equal(fake.bucket.size, 0, "the photos are still in the bucket after closing the account");
    const after = await sb.sbReadState("default");
    const parcel = after.packages[0];
    assert.equal(parcel.customerEmail, undefined, "the parcel is still linked to the account");
    assert.equal(parcel.customer.name, "(closed account)");
    assert.equal(parcel.customer.address, "");
    assert.equal(parcel.customer.city, "Dayton", "the lane should survive, it is not the person");
    assert.deepEqual(parcel.photos, {}, "the photo references should be gone too");
    // Asserted on the row, not only on the read: with the bytes deleted a dangling path yields
    // no signed URL either way, so reading {} does not prove the column was cleared.
    assert.equal(fake.rows.packages[0].photo_pickup, null, "the row still points at a deleted object");
    assert.equal(fake.rows.packages[0].photo_delivery, null);
    assert.equal(await store("granite-users").get(email), null, "the account should be deleted");
  });
});

test("packages.updated_at is maintained by a trigger, not by hope", () => {
  // The column defaulted to now() on insert and nothing ever touched it again, so a field
  // documented as "when this row last changed" reported when it was created -- for every row,
  // forever. A trigger rather than a line in rowFromPackage because the next writer will not
  // know it has to remember.
  assert.match(SQL, /create or replace function public\.touch_updated_at\(\) returns trigger/,
    "no touch_updated_at function");
  assert.match(SQL, /new\.updated_at := now\(\)/, "the trigger does not set updated_at");
  assert.match(SQL, /drop trigger if exists packages_touch_updated_at on public\.packages;/,
    "the trigger is not dropped first, so a re-run of the schema would fail");
  assert.match(SQL, /create trigger packages_touch_updated_at\s+before update on public\.packages/,
    "the trigger is not attached to packages before update");
});

test("a rate-limited signing request is retried, not taken as an absence of photos", async () => {
  // Measured against the real project: asking to sign 200 paths answered 429 too_many_connections,
  // and returning {} on that made every condition photo in the workspace vanish from the read --
  // indistinguishable from a workspace where nobody photographed anything. For a liability record
  // that is the worst possible way to fail.
  await withSupabase(async (sb, fake) => {
    const PNG = "data:image/png;base64," + Buffer.from("bytes").toString("base64");
    await sb.sbWriteState("default", {
      ...workspace(),
      packages: [{ id: "GL-8100", status: "Delivered", item: {}, customer: {}, history: [],
                   photos: { pickup: PNG, delivery: PNG } }],
    });

    fake.rateLimitSigns = 2;                 // the first two attempts are refused
    const after = await sb.sbReadState("default");
    const p = after.packages[0];
    assert.match(p.photos.pickup || "", /\/object\/sign\//, "the photo was lost to a transient 429");
    assert.match(p.photos.delivery || "", /\/object\/sign\//);
    assert.ok(fake.signRequests >= 3, "it should have retried: " + fake.signRequests + " request(s)");
  });
});

test("signing that keeps failing costs only the photos, never the parcel", async () => {
  await withSupabase(async (sb, fake) => {
    const PNG = "data:image/png;base64," + Buffer.from("bytes").toString("base64");
    await sb.sbWriteState("default", {
      ...workspace(),
      packages: [{ id: "GL-8101", status: "Delivered", item: { description: "Still here" },
                   customer: { city: "Dayton" }, history: [{ stage: "Won", ts: 1893400000000 }],
                   photos: { pickup: PNG } }],
    });
    fake.rateLimitSigns = 99;                // never recovers
    const after = await sb.sbReadState("default");
    const p = after.packages[0];
    assert.equal(p.id, "GL-8101", "the parcel itself must survive");
    assert.equal(p.item.description, "Still here");
    assert.equal(p.photos.pickup, undefined, "and the photo is simply absent");
    // The UI renders that absence as "Photo didn't load" rather than as "no photo was taken".
  });
});

test("signing is batched, and uploads are bounded", async () => {
  // Both are volume properties, invisible at the sizes the other tests use, and both were found by
  // measuring the real project: one un-chunked sign request for a whole workspace answered 429,
  // and unbounded uploads are what provoked that. Asserted as invariants so the numbers cannot
  // quietly go back to "all at once".
  await withSupabase(async (sb, fake) => {
    const PNG = "data:image/png;base64," + Buffer.from("bytes").toString("base64");
    // 130 parcels with two photos each: 260 uploads and 260 paths to sign.
    const packages = Array.from({ length: 130 }, (_, i) => ({
      id: "GL-" + (9000 + i), status: "Delivered", item: {}, customer: {}, history: [],
      photos: { pickup: PNG, delivery: PNG },
    }));
    await sb.sbWriteState("default", { ...workspace(), packages });

    assert.ok(fake.maxUploadsInFlight > 1, "uploads should overlap at all: " + fake.maxUploadsInFlight);
    // 48 parcels in flight, each issuing up to two uploads, so 96 requests is the ceiling. The
    // number matters less than the fact that there IS one: unbounded is what provoked the 429s.
    assert.ok(fake.maxUploadsInFlight <= 96,
      "uploads ran unbounded (" + fake.maxUploadsInFlight + " at once); Storage rate limits and the signing that follows pays for it");

    await sb.sbReadState("default");
    assert.ok(fake.signBatchSizes.length > 1,
      "the whole workspace was signed in one request (" + fake.signBatchSizes.join(",") + ")");
    assert.ok(Math.max(...fake.signBatchSizes) <= 100,
      "a sign batch exceeded 100 paths: " + fake.signBatchSizes.join(","));
  });
});
