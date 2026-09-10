// The records table: what it asks Supabase for, what it does with the answer, and
// whether it tells the truth about which tests ran. Functions are lifted out of
// index.html so these exercise the page's own code.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { extractFn, extractConst } = require("./extract.js");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const FULL_ROW = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "audit_row.json"), "utf8"));

// A sandbox with the page helpers these functions lean on.
function sandbox(extra) {
  const ctx = Object.assign({
    console, JSON, Math, Object, Array, String, Number, Date, Set, Map, isNaN, parseFloat, parseInt,
    encodeURIComponent, fetch: async () => { throw new Error("no fetch in this test"); },
    YCCertificate: require("../certificate.js"),
    escv: v => String(v == null ? "" : v),
    num: v => { const n = parseFloat(v); return isNaN(n) ? "" : n; },
    normResult: v => String(v || "").toUpperCase(),
    techLabel: (t, u) => t || u || "",
    faultPhrase: f => String(f || "").trim(),
    SUPA: "https://supa.test", KEY: "anon-key", MODE: "mac", RAW: [],
  }, extra || {});
  vm.createContext(ctx);
  return ctx;
}

function load(ctx, ...names) {
  ["SNAP_FIELDS", "LIST_COLS"].forEach(c => vm.runInContext(extractConst(html, c), ctx));
  names.forEach(n => vm.runInContext(extractFn(html, n), ctx));
  return ctx;
}

// ---------------------------------------------------------------- proof of run
const RAN = { ran: true, duration_s: 606, verdict: "NORMAL", bands: [] };

function execRow(details) {
  const ctx = load(sandbox(), "testExecHTML");
  return ctx.testExecHTML({ _raw: { snapshot: { details } } });
}

test("a drain test that ran is reported as run, with the length the engine measured", () => {
  const out = execRow({ battery_drain: RAN, thermal: { ran: true, duration_s: 330, bands: [] } });
  const row = out.split("<tr>").find(r => r.includes("Battery drain"));
  assert.match(row, /RUN — 10m 6s/);
  assert.doesNotMatch(row, /NOT RUN/);
});

test("a record saved before the fix reads NOT RUN — that result is unrecoverable", () => {
  // Those audits hold the battery's hardware facts under `battery` and no proof of run
  // at all, so whether the drain test ran cannot be known from them. The table says NOT
  // RUN rather than inventing a third state (matches the dashboard's own convention).
  const out = execRow({ thermal: { ran: true, duration_s: 330, bands: [] },
                        battery: { health_pct: 97, cycles: 35, condition: "Excellent" } });
  const row = out.split("<tr>").find(r => r.includes("Battery drain"));
  assert.match(row, /NOT RUN/);
});

test("a test that genuinely did not run still reads NOT RUN", () => {
  const out = execRow({ thermal: { ran: true, duration_s: 330, bands: [] },
                        battcell: { ran: false, bands: [] } });
  const row = out.split("<tr>").find(r => r.includes("Battery cell balance"));
  assert.match(row, /NOT RUN/);
});

test("an audit from before the feature existed shows no proof-of-run table at all", () => {
  assert.equal(execRow({ camera: { sharpness: 12 } }), "");
});

test("the certificate reads the drain test the same way the table does", () => {
  const { certificateRows } = require("../certificate.js");
  const ran = certificateRows({ details: { battery_drain: RAN } }).automated.find(a => a.id === "battery");
  assert.equal(ran.ran, true);
  assert.equal(ran.duration, "10m 6s");
  const old = certificateRows({ details: { battery: { health_pct: 97 } } }).automated.find(a => a.id === "battery");
  assert.ok(!old || old.recorded === false, "an unrecorded drain test is not presented as a failed one");
});

// --------------------------------------------------------------- the list query
test("the list never asks for the snapshot column", () => {
  const ctx = load(sandbox(), "listSelect");
  const sel = ctx.listSelect();
  assert.ok(!/(^|,)snapshot(,|$)/.test(sel), "select must not pull the whole snapshot: " + sel);
});

test("the list asks for every snapshot field the table actually renders", () => {
  const ctx = load(sandbox(), "listSelect");
  const sel = ctx.listSelect();
  // Derived from flat()'s own source, so adding a field to the table without adding
  // it to the query fails here instead of silently blanking a column in production.
  const used = new Set([...extractFn(html, "flat").matchAll(/\bs\.([a-z0-9_]+)/g)].map(m => m[1]));
  used.delete("details");
  const missing = [...used].filter(f => !sel.includes(`snapshot->>${f}`));
  assert.deepEqual(missing, [], "not requested: " + missing.join(", "));
});

test("a slim row flattens to exactly what the full row does", () => {
  const ctx = load(sandbox(), "flat", "listSelect", "unslim");
  const full = ctx.flat(FULL_ROW);
  // What PostgREST returns for listSelect(): the columns, plus one s_<field> per
  // snapshot field. Build that from the fixture and check the table sees no difference.
  const slim = { };
  for (const k of Object.keys(FULL_ROW)) if (k !== "snapshot") slim[k] = FULL_ROW[k];
  for (const [k, v] of Object.entries(FULL_ROW.snapshot)) {
    if (typeof v === "object") continue;                 // PostgREST ->> yields text
    slim["s_" + k] = v == null ? null : String(v);
  }
  const thin = ctx.flat(ctx.unslim(slim));
  for (const k of Object.keys(full)) {
    if (k === "_raw") continue;
    assert.deepEqual(String(thin[k] ?? ""), String(full[k] ?? ""), "field " + k);
  }
});

test("the full snapshot is fetched once per record, then cached", async () => {
  let calls = 0;
  const ctx = sandbox({ fetch: async () => { calls++;
    return { ok: true, json: async () => [{ snapshot: { details: { battery_drain: RAN } } }] }; } });
  load(ctx, "ensureSnapshot");
  const row = { id: "abc", _raw: { id: "abc" } };
  await ctx.ensureSnapshot(row);
  await ctx.ensureSnapshot(row);
  assert.equal(calls, 1, "a second open must not re-download the snapshot");
  assert.equal(row._raw.snapshot.details.battery_drain.ran, true);
});

test("a record whose snapshot cannot be loaded is left readable, not broken", async () => {
  const ctx = sandbox({ fetch: async () => { throw new Error("offline"); } });
  load(ctx, "ensureSnapshot");
  const row = { id: "abc", _raw: { id: "abc", snapshot: { model: "MacBook Air" } } };
  await ctx.ensureSnapshot(row);
  assert.equal(row._raw.snapshot.model, "MacBook Air");
});

// ------------------------------------------------------------------- rendering
test("the table renders a window, not fourteen thousand rows", () => {
  const ctx = load(sandbox(), "rowsToRender");
  const rows = Array.from({ length: 14055 }, (_, i) => ({ id: i }));
  assert.ok(ctx.rowsToRender(rows, 200).length <= 200);
  assert.equal(ctx.rowsToRender(rows.slice(0, 12), 200).length, 12, "a short list renders whole");
});

// --------------------------------------------------------- progressive loading
// The first page of records is back in ~2 s; the whole table takes ~28 s over 15
// sequential pages. Nothing may wait for the last page before the first is shown.
function pager(pages) {
  const calls = [];
  const fetchPage = async cursor => { calls.push(cursor); return pages[calls.length - 1] || []; };
  return { calls, fetchPage };
}
const rowsFor = (n, from) => Array.from({ length: n }, (_, i) =>
  ({ id: "id" + (from + i), tested_at: "2026-09-" + String(30 - Math.floor((from + i) / 1000)).padStart(2, "0") }));

test("each page is handed over as it lands, newest first, with the cursor of the page before", async () => {
  const ctx = load(sandbox(), "fetchPages");
  const p1 = rowsFor(3, 0), p2 = rowsFor(3, 3), p3 = rowsFor(1, 6);
  const { calls, fetchPage } = pager([p1, p2, p3]);
  const got = [];
  await ctx.fetchPages(fetchPage, batch => { got.push(batch.length); }, 3);
  assert.deepEqual(got, [3, 3, 1], "every page reaches the table, in order");
  assert.equal(calls[0], null, "the first page starts from the newest record");
  assert.deepEqual(calls[1], { ts: p1[2].tested_at, id: p1[2].id }, "page 2 continues from page 1's last row");
  assert.equal(calls.length, 3, "a short page is the end — no extra request");
});

test("the first page is on screen before the second has arrived", async () => {
  const ctx = load(sandbox(), "fetchPages");
  let releasePage2, shownBeforePage2 = null, painted = 0;
  const page2 = new Promise(r => { releasePage2 = r; });
  const fetchPage = async cursor => {
    if (cursor === null) return rowsFor(2, 0);
    shownBeforePage2 = painted;                 // what the tech sees while page 2 is in flight
    return page2;
  };
  const done = ctx.fetchPages(fetchPage, () => { painted++; }, 2);
  await new Promise(r => setTimeout(r, 0));
  releasePage2(rowsFor(1, 2));
  await done;
  assert.equal(shownBeforePage2, 1, "page 1 was painted while page 2 was still loading");
  assert.equal(painted, 2);
});

test("a load superseded mid-way stops asking for pages", async () => {
  const ctx = load(sandbox(), "fetchPages");
  const { calls, fetchPage } = pager([rowsFor(2, 0), rowsFor(2, 2), rowsFor(1, 4)]);
  await ctx.fetchPages(fetchPage, () => false, 2);   // onPage says: a newer load started
  assert.equal(calls.length, 1);
});
