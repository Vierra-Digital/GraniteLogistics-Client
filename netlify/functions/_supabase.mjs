// Supabase data layer: the workspace as rows instead of one jsonb blob.
//
// Reached only through readState/writeState in _lib.mjs, which pick this over Netlify Blobs
// when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both set. Every function that touches a
// workspace goes through that pair, so this is the whole swap.
//
// Talks PostgREST over fetch rather than pulling in @supabase/supabase-js: the operations here
// are a handful of selects and upserts, and a dependency that ships its own auth, realtime and
// storage clients earns nothing when the service role key is doing the authorizing.
//
// That key bypasses RLS. Correct here and only here: these functions already re-derive the
// caller's role server-side on every request, and RLS exists to defend the database from a
// browser holding the anon key. The service key must never be sent to the client.
import crypto from "node:crypto";

const PHOTO_BUCKET = "condition-photos";
// Long enough for a driver to open a photo, short enough that a copied link is worthless by
// the time it is shared. Minted server-side per request, including for public tracking.
export const PHOTO_URL_TTL = 600;

// Read the environment per call rather than at import: tests flip these between cases, and a
// function instance is reused across invocations.
const env = () => ({
  url: (process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
  key: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
});
export function supabaseConfigured() { const e = env(); return !!(e.url && e.key); }

async function sb(path, { method = "GET", body, prefer, headers } = {}) {
  const e = env();
  const res = await fetch(e.url + path, {
    method,
    headers: {
      apikey: e.key,
      Authorization: "Bearer " + e.key,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const err = new Error("supabase " + method + " " + path + " -> " + res.status + " " + String(text).slice(0, 300));
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

const q = (s) => encodeURIComponent(s);
const tsOut = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const tsIn = (iso) => (iso ? Date.parse(iso) : null);

// ---- photos --------------------------------------------------------------------------
// A condition photo is ~110,000 characters as a data URL, and two per parcel put a hard
// ceiling near 23 parcels on a device. Rows carry a Storage path; the bytes live in a private
// bucket, read through a signed URL that expires.
function decodeDataUrl(v) {
  if (typeof v !== "string" || !v.startsWith("data:")) return null;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(v);
  if (!m) return null;
  return { type: m[1], bytes: Buffer.from(m[2], "base64") };
}
const EXT = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };

// Returns a storage path, or null. A value that is already a path (or a signed URL read back
// from an earlier pull) is passed through rather than re-uploaded.
async function uploadPhoto(tenant, pkgId, kind, value) {
  const d = decodeDataUrl(value);
  if (!d) {
    if (typeof value !== "string" || !value) return null;
    if (value.startsWith("http")) return storagePathOf(value);
    return value;
  }
  const path = tenant + "/" + pkgId + "/" + kind + "." + (EXT[d.type] || "bin");
  const e = env();
  const res = await fetch(e.url + "/storage/v1/object/" + PHOTO_BUCKET + "/" + path, {
    method: "POST",
    headers: { apikey: e.key, Authorization: "Bearer " + e.key, "Content-Type": d.type, "x-upsert": "true" },
    body: d.bytes,
  });
  // A failed upload must not cost the parcel. The row is written either way and the photo is
  // simply absent, which the UI already renders as "No condition photos yet".
  if (!res.ok) return null;
  return path;
}

// A client that pulled, then pushed back, returns the signed URL it was given. Recover the
// path from it so a round trip does not overwrite the path with an expiring URL.
export function storagePathOf(signedUrl) {
  const m = new RegExp("/storage/v1/object/sign/" + PHOTO_BUCKET + "/([^?]+)").exec(String(signedUrl || ""));
  return m ? decodeURIComponent(m[1]) : null;
}

// A caller holds whatever a read gave it: a signed URL. To delete the object it needs the path
// back, and a path may also arrive directly (from a row, or from the migration transform).
export function photoPathOf(value) {
  if (typeof value !== "string" || !value) return null;
  if (value.startsWith("data:")) return null;             // never stored
  if (value.startsWith("http")) return storagePathOf(value);
  return value;
}

// Storage has no garbage collection. Clearing photo_pickup leaves the bytes in the bucket, so
// anything that promises a photo is gone has to remove the object as well as the reference.
export async function deletePhotoObjects(paths) {
  const wanted = [...new Set(paths.map(photoPathOf).filter(Boolean))];
  if (!wanted.length) return { ok: true, removed: 0 };
  const e = env();
  const res = await fetch(e.url + "/storage/v1/object/" + PHOTO_BUCKET, {
    method: "DELETE",
    headers: { apikey: e.key, Authorization: "Bearer " + e.key, "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: wanted }),
  });
  // Reported rather than thrown: a failed cleanup must not block closing an account, but it
  // must not be mistaken for success either.
  return { ok: res.ok, removed: res.ok ? wanted.length : 0, attempted: wanted.length };
}

// Signed in batches rather than one request per photo: a 40-parcel workspace would otherwise cost
// 80 round trips on every read.
//
// Batched, not sent as one request. Storage rate limits, and a read asks for every photo in the
// workspace -- often immediately after the push that uploaded them. Asking for 200 at once
// answered 429, and returning {} on that made every photo in the workspace disappear from the
// read, which is indistinguishable from nobody having taken any. A slice that still fails after
// its retries costs only its own photos, and those now render as "Photo didn't load" rather than
// as an absence.
const SIGN_CHUNK = 100;
const SIGN_RETRIES = 3;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function signPhotoPaths(paths) {
  const wanted = [...new Set(paths.filter(Boolean))];
  if (!wanted.length) return {};
  const e = env();
  const out = {};
  for (let i = 0; i < wanted.length; i += SIGN_CHUNK) {
    const slice = wanted.slice(i, i + SIGN_CHUNK);
    for (let attempt = 1; attempt <= SIGN_RETRIES; attempt++) {
      const res = await fetch(e.url + "/storage/v1/object/sign/" + PHOTO_BUCKET, {
        method: "POST",
        headers: { apikey: e.key, Authorization: "Bearer " + e.key, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: PHOTO_URL_TTL, paths: slice }),
      });
      if (res.ok) {
        const list = await res.json().catch(() => []);
        for (const row of Array.isArray(list) ? list : []) {
          const signed = row.signedURL || row.signedUrl;
          if (row.path && signed) out[row.path] = e.url + "/storage/v1" + (String(signed).startsWith("/") ? signed : "/" + signed);
        }
        break;
      }
      // Only a rate limit is worth waiting out. Anything else will not improve on a retry.
      if (res.status !== 429 || attempt === SIGN_RETRIES) break;
      await pause(120 * attempt);
    }
  }
  return out;
}

// ---- row <-> package ------------------------------------------------------------------
// A parcel's row identity, derived from the identity the client is stable on rather than
// generated.
//
// This has to be deterministic. Only the server order paths mint a uid, so anything an
// operator creates in the app -- manual intake, the demo seed -- arrives without one, and a
// random uid per call would insert a second row on the second push and then violate
// unique (tenant, id): a 409 on every sync after the first. Same argument for the migration
// SQL, which seeds rows this code later has to recognise as the same parcels.
//
// UUIDv5-shaped (sha1, version and variant bits set) so Postgres accepts it as a uuid and it
// is visibly derived rather than mistaken for a secret.
export function stableUid(tenant, id) {
  const h = crypto.createHash("sha1").update("granite:" + tenant + "\u0000" + id).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString("hex");
  return [x.slice(0, 8), x.slice(8, 12), x.slice(12, 16), x.slice(16, 20), x.slice(20)].join("-");
}

// An id lives in two places on a package, so renumbering has to move both.
export function renumber(order, id) {
  order.id = id;
  order.barcode = id.replace(/-/g, "");
  return order;
}

// pendingSync and syncRejected are deliberately absent: they describe whether THIS device has
// managed to reach the server, which is meaningless once stored on it.
function rowFromPackage(tenant, p, photo, syncToken) {
  return {
    uid: stableUid(tenant, p.id),
    tenant,
    id: p.id,
    order_uid: p.uid || null,
    status: p.status || "Won",
    source: p.source || null,
    order_ref: p.orderRef || null,
    barcode: p.barcode || null,
    carrier: p.carrier || null,
    lane: p.lane || null,
    batch_id: p.batchId || null,
    tracking: p.tracking || null,
    item: p.item || {},
    customer: p.customer || {},
    customer_email: p.customerEmail || null,
    photo_pickup: photo.pickup || null,
    photo_delivery: photo.delivery || null,
    sync_token: syncToken,
    load_unit: p.loadUnit || null,
    sort_zone: p.sortZone || null,
    presort_lane: p.presortLane || null,
    promised_at: tsOut(p.promisedTs),
    exception: p.exception || null,
    return_state: p.return || null,
    created_at: tsOut(typeof p.createdAt === "number" ? p.createdAt : ((p.history || [])[0] || {}).ts) || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
}

function packageFromRow(r, events, signed) {
  const photos = {};
  if (r.photo_pickup && signed[r.photo_pickup]) photos.pickup = signed[r.photo_pickup];
  if (r.photo_delivery && signed[r.photo_delivery]) photos.delivery = signed[r.photo_delivery];
  const pkg = {
    id: r.id,
    status: r.status,
    source: r.source || undefined,
    orderRef: r.order_ref || undefined,
    barcode: r.barcode || undefined,
    carrier: r.carrier,
    lane: r.lane,
    batchId: r.batch_id,
    tracking: r.tracking,
    item: r.item || {},
    customer: r.customer || {},
    photos,
    // Sorted here rather than trusted from the query. An embedded resource comes back in no
    // promised order, and the app reads this as a timeline: out of order it draws the custody
    // chain backwards, and history[0].ts is what orderCreatedAt falls back to for rate
    // limiting. Cheap at these lengths, and it cannot be undone by a query-string change.
    history: (events[r.uid] || [])
      .map((e) => {
        const h = { stage: e.stage, ts: tsIn(e.at) };
        if (e.note) h.note = e.note;
        return h;
      })
      .sort((a, b) => a.ts - b.ts),
    promisedTs: tsIn(r.promised_at),
    exception: r.exception || null,
    createdAt: tsIn(r.created_at),
  };
  // Only a server-minted order uid travels back to the client; the row identity stays here.
  if (r.order_uid) pkg.uid = r.order_uid;
  if (r.customer_email) pkg.customerEmail = r.customer_email;
  if (r.load_unit) pkg.loadUnit = r.load_unit;
  if (r.sort_zone) pkg.sortZone = r.sort_zone;
  if (r.presort_lane) pkg.presortLane = r.presort_lane;
  if (r.return_state) pkg.return = r.return_state;
  return pkg;
}

// Settings belonging to a device or to a credential store, not to a workspace. `cloud` holds
// the sync url and api key; theme and role are properties of a device, not of a business. The
// client already never applies settings from a server pull, so dropping them changes nothing.
const DEVICE_SETTINGS = ["cloud", "theme", "role", "roleChosen"];
export function settingsForStorage(settings) {
  const out = { ...(settings || {}) };
  for (const k of DEVICE_SETTINGS) delete out[k];
  return out;
}

// ---- read -----------------------------------------------------------------------------
// Rows are fetched a page at a time. PostgREST caps a response at its configured max-rows, and
// a workspace here runs to thousands of parcels, so reading in one request silently truncates.
// Paging until a short page arrives is the only way to know the whole workspace was returned.
const PAGE = 1000;
async function page(path) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const batch = await sb(path + "&limit=" + PAGE + "&offset=" + offset) || [];
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
}

export async function sbReadState(tenant) {
  const t = q(tenant);
  // Custody entries come back nested inside their parcel via the foreign key rather than as a
  // second query keyed on every uid. That query put one 36-character uuid per parcel into the
  // URL, which passed at a hundred parcels and failed outright at a few hundred -- roughly
  // 18 KB of query string. Embedding is one request, constant length, and cannot truncate a
  // parcel's history away from it.
  const [pkgRows, manifests, units, activity, settingsRows] = await Promise.all([
    page("/rest/v1/packages?tenant=eq." + t + "&deleted_at=is.null&order=created_at.asc" +
         "&select=*,package_events(stage,note,at)"),
    page("/rest/v1/manifests?tenant=eq." + t + "&select=*&order=created_at.desc"),
    page("/rest/v1/load_units?tenant=eq." + t + "&select=*&order=created_at.desc"),
    // Capped, and deliberately: the Activity view lists recent workspace entries, not an
    // unbounded history, and the client re-pushes what it holds. The 500 newest are returned,
    // so an entry older than that is readable in the database but not through a pull.
    sb("/rest/v1/activity_events?tenant=eq." + t + "&select=*&order=at.desc&limit=500"),
    sb("/rest/v1/workspace_settings?tenant=eq." + t + "&select=settings"),
  ]);

  const events = {};
  for (const r of pkgRows) events[r.uid] = r.package_events || [];

  const signed = await signPhotoPaths(pkgRows.flatMap((r) => [r.photo_pickup, r.photo_delivery]));
  const packages = pkgRows.map((r) => packageFromRow(r, events, signed));

  // packageIds and parcels are membership, derived from the parcels themselves so the two can
  // never disagree with each other.
  const idsBy = (field, value) => packages.filter((p) => p[field] === value).map((p) => p.id);
  return {
    packages,
    manifests: (manifests || []).map((m) => {
      const out = { id: m.id, carrier: m.carrier, lane: m.lane, ts: tsIn(m.created_at), packageIds: idsBy("batchId", m.id) };
      if (m.transmitted) out.transmitted = true;
      return out;
    }),
    loadUnits: (units || []).map((u) => ({
      id: u.id, zone: u.zone, lane: u.lane, weightLb: u.weight_lb, ts: tsIn(u.created_at),
      parcels: idsBy("loadUnit", u.id),
    })),
    events: (activity || []).map((e) => {
      const out = { ts: tsIn(e.at) };
      if (e.package_id) out.pkgId = e.package_id;
      if (e.who) out.who = e.who;
      if (e.kind) out.kind = e.kind;
      if (e.note) out.note = e.note;
      return out;
    }),
    settings: (settingsRows && settingsRows[0] && settingsRows[0].settings) || {},
  };
}

// ---- write ----------------------------------------------------------------------------
// Every write here is the same shape: upsert a list against a named conflict target, doing
// nothing when the list is empty. `merge` overwrites the stored row (the client is the
// authority on a parcel's current state); `ignore` keeps the first write and drops repeats,
// which is what makes an append-only table survive the same push arriving twice.
// Sent in chunks: 3000 parcels is ~12,000 custody rows, and one request carrying all of them
// is a multi-megabyte body against a function with a payload limit. Chunks also mean a failure
// reports which slice failed instead of losing the whole push.
//
// Chunks go out a few at a time. Serially, a 3000-parcel push took 4.9s of a 10s function
// budget; the work is latency-bound, not database-bound. LANES is deliberately small -- the
// point is to stop waiting on one round trip at a time, not to open thirty connections against
// a pooler shared with every other request the deployment is serving.
const CHUNK = 500;
const LANES = 4;
// PARCELS uploaded at once, not requests: each one issues up to two (pickup and delivery), so the
// ceiling on simultaneous Storage requests is twice this. Photos hit a different service than the
// rows do, so they get their own budget.
//
// 48 measured against the real project. Only FRESH photos upload -- one already stored comes back
// as a signed URL and short-circuits -- and the client cannot hold many un-synced, because a data
// URL is ~110,000 characters against a 5.24M localStorage budget, so about 47 is the ceiling on
// one push. 48 clears that in a single batch. Bounded rather than unbounded because 800 at once
// (a figure only a synthetic fixture reaches) tips Storage into rate limiting the signing that
// follows, and that failure used to lose every photo in the read.
const UPLOAD_LANES = 48;
async function upsert(table, conflict, resolution, rows) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));
  const send = (body) => sb("/rest/v1/" + table + "?on_conflict=" + conflict, {
    method: "POST", body, prefer: "resolution=" + resolution + "-duplicates,return=minimal",
  });
  for (let i = 0; i < chunks.length; i += LANES) {
    await Promise.all(chunks.slice(i, i + LANES).map(send));
  }
}
const ensureTenant = (tenant) => upsert("tenants", "slug", "ignore", [{ slug: tenant }]);

// Photos are uploaded before the row is written, so a row can never point at bytes that
// failed to arrive. Shared by the whole-workspace push and the single-order append.
async function rowWithPhotos(tenant, p, syncToken) {
  const photos = p.photos || {};
  const [pickup, delivery] = await Promise.all([
    photos.pickup ? uploadPhoto(tenant, p.id, "pickup", photos.pickup) : null,
    photos.delivery ? uploadPhoto(tenant, p.id, "delivery", photos.delivery) : null,
  ]);
  return rowFromPackage(tenant, p, { pickup, delivery }, syncToken);
}

const custodyRows = (uid, history, fallbackAt) =>
  (Array.isArray(history) ? history : [])
    .filter((h) => h && h.stage)
    .map((h) => ({ package_uid: uid, stage: h.stage, note: h.note || null, at: tsOut(h.ts) || fallbackAt }));

export async function sbWriteState(tenant, data) {
  await ensureTenant(tenant);

  const pushedAt = new Date().toISOString();
  // Identifies this push. Not a timestamp: see sync_token in the schema.
  const token = crypto.randomUUID();
  const packages = Array.isArray(data.packages) ? data.packages.filter((p) => p && p.id) : [];
  // Photos in parallel, but bounded. A serial loop made a first sync of forty photographed
  // parcels forty sequential round trips; unbounded made 400 parcels fire 800 simultaneous
  // uploads, which is what tipped Storage into rate limiting the signing that follows. Order is
  // preserved because rows[i] is zipped with packages[i] for the custody rows below.
  const rows = [];
  for (let i = 0; i < packages.length; i += UPLOAD_LANES) {
    rows.push(...await Promise.all(packages.slice(i, i + UPLOAD_LANES).map((p) => rowWithPhotos(tenant, p, token))));
  }

  await upsert("packages", "uid", "merge", rows);
  await upsert("package_events", "package_uid,stage,at", "ignore",
    rows.flatMap((r, i) => custodyRows(r.uid, packages[i].history, r.created_at)));

  // Anything stored for this tenant and absent from this push is a deletion, recorded as
  // deleted_at rather than removed so a later pull cannot resurrect it and an audit still has
  // it. This is what retires the client's tombstone array.
  //
  // Identified by token, not by listing what to keep: every row above carries this push's
  // token, so a row without it was not in the push. Listing uids instead would put a uuid per
  // parcel into the URL, which is the bug that made reads fail at a few hundred parcels.
  await sb("/rest/v1/packages?tenant=eq." + q(tenant) + "&deleted_at=is.null&sync_token=neq." + q(token), {
    method: "PATCH", body: { deleted_at: pushedAt }, prefer: "return=minimal",
  });

  const now = () => new Date().toISOString();
  await upsert("manifests", "tenant,id", "merge",
    (Array.isArray(data.manifests) ? data.manifests : []).filter((m) => m && m.id).map((m) => ({
      tenant, id: m.id, carrier: m.carrier || null, lane: m.lane || null,
      transmitted: !!m.transmitted, created_at: tsOut(m.ts) || now(),
    })));

  await upsert("load_units", "tenant,id", "merge",
    (Array.isArray(data.loadUnits) ? data.loadUnits : []).filter((u) => u && u.id).map((u) => ({
      tenant, id: u.id, zone: u.zone || null, lane: u.lane || null,
      weight_lb: Number.isFinite(u.weightLb) ? u.weightLb : null, created_at: tsOut(u.ts) || now(),
    })));

  await upsert("activity_events", "tenant,package_id,kind,at", "ignore",
    (Array.isArray(data.events) ? data.events : []).filter((e) => e && e.ts).map((e) => ({
      tenant, package_id: e.pkgId || null, kind: e.kind || null,
      who: e.who || null, note: e.note || null, at: tsOut(e.ts),
    })));

  await upsert("workspace_settings", "tenant", "merge",
    [{ tenant, settings: settingsForStorage(data.settings), updated_at: now() }]);
}

// ---- appending one order --------------------------------------------------------------
// The Blobs path needs appendOrderWithRepair because a single blob has no row-level
// concurrency: two racing writers lose an order and can mint the same GL-#### twice. Here the
// database refuses both outcomes -- uid is the primary key, (tenant, id) is unique -- so a
// collision arrives as a 409 and the only work left is to take the next free id and retry.
export async function sbAppendOrder(tenant, build, attempts = 5) {
  await ensureTenant(tenant);
  let order = null;
  let repaired = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Only the ids are needed to number the next one. Both builders in this codebase
    // (makeOrder, makeCustomerOrder) read nothing else off the state they are handed, and a
    // test pins that so a future one cannot quietly start depending on more.
    const taken = await sb("/rest/v1/packages?tenant=eq." + q(tenant) + "&select=id") || [];
    if (!order) {
      order = build({ packages: taken });
      // Distinct from the row identity: this marks the parcel as server-created, which is how
      // mergePushedPackages knows not to let a stale ops push delete it.
      if (!order.uid) order.uid = crypto.randomUUID();
    } else {
      let max = 1040;
      for (const r of taken) { const m = /GL-(\d+)/.exec(r.id || ""); if (m) max = Math.max(max, +m[1]); }
      renumber(order, "GL-" + (max + 1));
    }

    const row = await rowWithPhotos(tenant, order);
    try {
      await sb("/rest/v1/packages", { method: "POST", body: row, prefer: "return=minimal" });
    } catch (e) {
      // 409 is the unique constraint doing its job: somebody took this id first.
      if (e.status === 409 && attempt < attempts) { repaired++; continue; }
      throw e;
    }

    await upsert("package_events", "package_uid,stage,at", "ignore",
      custodyRows(row.uid, order.history, row.created_at));
    return { order, state: await sbReadState(tenant), attempts: attempt, repaired };
  }
  return { order, state: await sbReadState(tenant), attempts, repaired, unverified: true };
}
