// The phone side of the portal (mobile.js) and its wiring into the page: what the iPhones
// list asks for, how a row is shaped, and the label / certificate / report it prints. The
// fixture is a real saved test with every device identifier replaced by an invented one.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { extractFn } = require("./extract.js");
const M = require("../mobile.js");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const ROW = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "mobile_audit_row.json"), "utf8"));
const clone = o => JSON.parse(JSON.stringify(o));

// What PostgREST answers for the slim list: the columns, plus one s_<field> per snapshot field.
function slimOf(row) {
  const out = {};
  M.COLS.forEach(c => { out[c] = row[c] === undefined ? null : row[c]; });
  M.SNAP_TEXT.forEach(f => { const v = row.snapshot[f]; out["s_" + f] = v == null ? null : String(v); });
  M.SNAP_JSON.forEach(f => { out["s_" + f] = row.snapshot[f] === undefined ? null : row.snapshot[f]; });
  return out;
}
function unslim(row) {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(extractFn(html, "unslim"), ctx);
  return ctx.unslim(row);
}

// ------------------------------------------------------------------- the list
test("the phone list never downloads a whole snapshot", () => {
  [true, false].forEach(stored => {
    const cols = M.listSelect(stored).split(",");
    assert.ok(!cols.includes("snapshot"), "no bare snapshot column");
    ["photos", "wipe_certificate", "on_device_reasons", "changes_from_previous", "*"].forEach(c =>
      assert.ok(!cols.includes(c), c + " is left for the opened record"));
  });
});

test("with the stored columns the list does not touch the snapshot at all", () => {
  assert.ok(!M.listSelect(true).includes("snapshot"));
});

test("without them the same keys are read out of the snapshot by the database", () => {
  const keys = sel => sel.split(",").map(c => c.split(":")[0]).sort();
  assert.deepEqual(keys(M.listSelect(false)), keys(M.listSelect(true)), "same answer shape either way");
  assert.ok(M.listSelect(false).includes("s_model:snapshot->>model"));
  assert.ok(M.listSelect(false).includes("s_blockers:snapshot->blockers"), "lists stay lists (->, not ->>)");
});

test("a slim row shapes to exactly what the whole row does", () => {
  const whole = M.flat(ROW), thin = M.flat(unslim(slimOf(ROW)));
  for (const k of Object.keys(whole)) {
    if (k === "_raw") continue;
    assert.deepEqual(thin[k], whole[k], "field " + k);
  }
});

test("the list asks for every snapshot field the row shaping reads", () => {
  // Derived from flat()'s own source: a field added to the table without adding it to the
  // query fails here instead of silently blanking a column.
  const src = M.flat.toString();
  const used = new Set([...src.matchAll(/\bs\.([a-z_]+)/g)].map(m => m[1]));
  const typed = new Set(M.COLS);
  const have = new Set(M.SNAP_TEXT.concat(M.SNAP_JSON));
  // Fallbacks for a column of the row itself, which the list already has.
  const missing = [...used].filter(f => !have.has(f) && !typed.has(f) && !["timestamp", "marketing_name", "photo_count"].includes(f));
  assert.deepEqual(missing, []);
});

// ------------------------------------------------------------------- one row
test("REVIEW is a verdict of its own, not OTHER", () => {
  assert.equal(M.verdict("review"), "REVIEW");
  assert.equal(M.verdict("pass"), "PASS");
  assert.equal(M.verdict("fail"), "FAIL");
  assert.equal(M.verdict(""), "");
  assert.equal(M.flat(Object.assign(clone(ROW), { result: "review" })).result, "REVIEW");
});

test("a 1 TB phone is not shown as 1 GB", () => {
  const r = M.flat(Object.assign(clone(ROW), { storage_total_gb: "1 TB" }));
  assert.equal(r.storage_text, "1 TB");
  assert.equal(r.storage, 1024, "and sorts above 512 GB");
  assert.equal(M.flat(ROW).storage_text, "128 GB");
  assert.equal(M.storageText(256), "256 GB");
});

test("the test time is the bench's own wall clock, written as on its printouts", () => {
  assert.equal(M.flat(ROW).tested_local, "05 Oct 2026, 22:10");
  assert.equal(M.localStamp("5 Oct 2026 22:10"), "5 Oct 2026 22:10", "any other shape is left as saved");
  assert.equal(M.localStamp(""), "");
});

test("carrier lock is read from the words the Mac saved", () => {
  assert.equal(M.carrier("unlocked (Settings: no SIM restrictions)").state, "clean");
  assert.equal(M.carrier("unlocked (takes the test SIM)").state, "clean");
  assert.equal(M.carrier("locked (rejects the test SIM)").state, "locked");
  assert.equal(M.carrier("locked (Settings: SIM locked)").state, "locked");
  assert.equal(M.carrier("not checked").state, "unknown", "not checked is never shown as unlocked");
  assert.equal(M.carrier("", null).state, "unknown");
  const r = M.flat(ROW);
  assert.equal(r.carrier, "clean");
  assert.match(r.carrier_words, /no SIM restrictions/);
});

test("the row carries why it was saved, by which Probe and Mac build, on which port", () => {
  const r = M.flat(ROW);
  assert.equal(r.save_reason, "phone left the bench");
  assert.equal(r.probe_version, "1.7 (49)");
  assert.equal(r.app_build, "202610052106");
  assert.equal(r.port, "2");
  assert.equal(r.checks_total, 35);
  assert.equal(r.checks_passed, 32);
  assert.equal(r.checks_failed, 1);
});

test("Apple's parts check is summed up, worst first in tone", () => {
  assert.deepEqual(M.partsSummary([{ part: "Display", status: "genuine" }]), { state: "ok", words: "All genuine" });
  assert.equal(M.partsSummary([{ part: "Battery", status: "used" }]).state, "warn");
  const p = M.partsSummary(ROW.snapshot.parts_service);
  assert.equal(p.state, "bad");
  assert.equal(p.words, "Display: repair not finished · Battery: used");
  assert.equal(M.partsSummary([], "pass").words, "Checked on the phone");
  assert.equal(M.partsSummary([], undefined).words, "", "not read is blank, never 'genuine'");
});

test("faults are the Mac's own reasons; a bare count is spelled out with the failed tests", () => {
  const row = clone(ROW);
  row.on_device.cameras = "fail"; row.on_device.torch = "fail";
  row.snapshot.blockers = ["2 functional tests FAILED", "Parts authenticity check FAILED — Unknown part: Camera",
                           "Battery health 74% — below the 85% floor"];
  const r = M.flat(row);
  assert.match(r.faults, /2 functional tests FAILED: Cameras present, Flashlight/);
  assert.deepEqual(r.fault_tags, ["Unknown part: Camera", "Battery health below the floor", "Cameras present", "Flashlight"]);
});

test("the bare count names only what it counts: the heat and parts checks have lines of their own", () => {
  // A real record: Face ID failed, the heat test failed (its own line), and the parts check
  // failed on the phone without the Mac giving it a line.
  const row = clone(ROW);
  row.on_device.biometric = "fail"; row.on_device.stress_thermal = "fail"; row.on_device.parts_authenticity = "fail";
  row.snapshot.blockers = ["1 functional test FAILED",
    "Stress / thermal test FAILED — Reached critical after 8m 41s under full load, off the cable",
    "Face ID dot projector is dead — the phone has switched it off for good (Face ID cannot work)"];
  const r = M.flat(row);
  assert.ok(r.faults.startsWith("1 functional test FAILED: Face ID / Touch ID auth;"), r.faults);
  assert.deepEqual(r.fault_tags, ["Stress / thermal test FAILED", "Face ID dot projector is dead",
                                  "Face ID / Touch ID auth", "Parts authenticity"]);
});

test("the same fault with different numbers counts as one in the analysis", () => {
  assert.equal(M.faultTag("Battery health 74% — below the 85% floor"), M.faultTag("Battery health 77% — below the 80% floor"));
  assert.equal(M.faultTag("4 hardware-fault panics on record (Display (DCP))"), "Hardware-fault panics on record");
});

test("a record from before the Mac kept its reasons falls back to the failed tests' names", () => {
  const row = clone(ROW);
  delete row.snapshot.blockers;
  assert.equal(M.flat(row).faults, "Parts authenticity");
});

test("cosmetic marks are not counted as faults", () => {
  const row = clone(ROW);
  row.defects = "Scratch (back, light); Dent (frame)"; row.snapshot.blockers = []; row.on_device.parts_authenticity = "pass";
  const r = M.flat(row);
  assert.equal(r.faults, "");
  assert.equal(r.cosmetic, "Scratch (back, light); Dent (frame)");
});

// ------------------------------------------------------------------- Code 128
// Decode the bars back into text with nothing but the symbol table: a label that does not
// read back is a label a scanner cannot read.
function decode128(svg) {
  const widths = [...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map(m => [+m[1], +m[2]]);
  const total = +svg.match(/viewBox="0 0 (\d+) 10"/)[1];
  let mods = "", at = 0;
  widths.forEach(([x, w]) => { if (x > at) mods += String(x - at); mods += String(w); at = x + w; });
  if (at < total) mods += String(total - at);
  const TABLE = vm.runInNewContext("(function(){" + fs.readFileSync(path.join(__dirname, "..", "mobile.js"), "utf8")
    .match(/var C128 = \[[\s\S]*?\];/)[0] + " return C128;})()");
  const vals = [];
  for (let i = 0; i < mods.length;) {
    const stop = mods.slice(i, i + 7);
    if (stop === "2331112") { vals.push(106); i += 7; continue; }
    const v = TABLE.indexOf(mods.slice(i, i + 6));
    assert.ok(v > -1, "every 6 bars are a real symbol");
    vals.push(v); i += 6;
  }
  assert.equal(vals.pop(), 106, "ends on the stop symbol");
  const check = vals.pop();
  assert.equal(check, vals.reduce((s, v, i) => s + v * (i || 1), 0) % 103, "checksum");
  let set = vals[0] === 105 ? "C" : "B", out = "";
  vals.slice(1).forEach(v => {
    if (set === "C") { if (v === 100) set = "B"; else out += String(v).padStart(2, "0"); }
    else if (v === 99) set = "C"; else out += String.fromCharCode(v + 32);
  });
  return { text: out, symbols: vals.length + 2, modules: total };
}

test("an IMEI, a serial and a mixed code all read back from their bars", () => {
  ["350000000000006", "F7QTEST12ABC", "K4WTEST01AB", "C02ZX1234ABC", "IP-14-128-PE-MN-A", "12345", "A1", "0000", "AB123456CD", "9"].forEach(code =>
    assert.equal(decode128(M.code128(code)).text, code, code));
});

test("digits are packed two to a symbol, as on the Mac's own labels", () => {
  const d = decode128(M.code128("350000000000006"));
  assert.equal(d.modules, 134, "a 15-digit IMEI is 134 modules, not 200 — it still scans on the 57 mm box label");
});

test("no code, no bars", () => {
  assert.equal(M.code128(""), "");
});

// ------------------------------------------------------------------- the printouts
test("the label, certificate and report are the ones the Mac saved with the test", () => {
  const d = M.docs(ROW);
  assert.equal(d.kept, true);
  assert.equal(d.label.verdict, "FAIL");
  assert.equal(d.label.port, "2");
  assert.equal(d.report.tests.length, 35);
  assert.equal(d.certificate, null, "a failed phone has no certificate");
  assert.match(d.certificateReason, /FAIL/);
});

test("a test saved before printouts were kept is rebuilt from its own fields", () => {
  const row = clone(ROW);
  delete row.snapshot.print;
  const d = M.docs(row);
  assert.equal(d.kept, false);
  assert.equal(d.label.verdict, "FAIL");
  assert.equal(d.label.serial, "F7QTEST12ABC");
  assert.equal(d.label.icloud, "Off");
  assert.equal(d.label.tests, "32/35");
  assert.equal(d.report.tests.length, 35);
  assert.equal(d.report.tests.find(t => t.name === "Parts authenticity").result, "fail");
  assert.equal(d.certificate, null);
});

test("a failed phone's unit label shows its faults, not the six spec boxes", () => {
  const out = M.labelHTML(M.docs(ROW).label, "unit");
  assert.ok(out.includes('class="flt"'));
  assert.ok(!out.includes('class="specs"'));
  assert.equal((out.match(/<div class="one">[✗!]/g) || []).length, 3, "three lines at most");
  assert.ok(out.includes("Display repair not finished"));
  assert.ok(!out.includes('class="vd pass"'), "FAIL is outlined, only PASS is the solid box");
  assert.equal((out.match(/<svg/g) || []).length, 2, "IMEI and serial barcodes");
});

test("a phone that passed gets the six spec boxes and the solid PASS", () => {
  const u = Object.assign({}, M.docs(ROW).label, { verdict: "PASS", faults: [], grade: "A", sku: "IP-12PRO-128-PE-GR-A" });
  const out = M.labelHTML(u, "unit");
  assert.ok(out.includes('class="specs"'));
  assert.ok(out.includes('class="vd pass"'));
  ["BATTERY", "CYCLES", "PARTS", "SIM", "iCLOUD", "TESTS"].forEach(k => assert.ok(out.includes(">" + k + "<"), k));
  assert.ok(out.includes("height:7.4mm"), "full-height barcodes when there are no fault lines");
});

// ---- cosmetic marks on the unit label
test("cosmetic marks are grouped by face and repeats are counted", () => {
  assert.deepEqual(M.cosmeticGroups("Glass cracked (Front); Glass cracked (Front); Frame dent (Front); Frame scratch (Right)"),
    ["Front: Glass cracked ×2, Frame dent", "Right: Frame scratch"]);
  assert.deepEqual(M.cosmeticGroups(""), []);
  assert.deepEqual(M.cosmeticGroups("Scuff"), ["Body: Scuff"], "a mark with no face is still named");
});

test("the unit label mentions the cosmetic defects, whatever the verdict", () => {
  const groups = ["Front: Glass cracked ×2, Frame dent", "Right: Frame scratch"];
  const pass = Object.assign({}, M.docs(ROW).label, { verdict: "PASS", faults: [], cosmetic: groups });
  const out = M.labelHTML(pass, "unit");
  assert.ok(out.includes("COSMETIC  Front: Glass cracked ×2, Frame dent · Right: Frame scratch"));
  assert.ok(out.includes('class="specs"'), "a phone that passed keeps its six boxes too");
  const fail = M.labelHTML(Object.assign({}, M.docs(ROW).label, { cosmetic: groups }), "unit");
  assert.ok(fail.includes("COSMETIC  Front: Glass cracked"), "a failed phone's label carries them under its faults");
  assert.ok(fail.includes('class="flt"'));
  assert.ok(!M.labelHTML(M.docs(ROW).label, "unit").includes("COSMETIC"), "no marks, no line");
});

test("many marks take two lines and the barcodes keep their numbers on the label", () => {
  const many = ["Front: Glass cracked ×2, Frame dent", "Right: Frame scratch", "Left: Frame scratch",
                "Back: Back glass scratch, Camera lens scratch", "Top: Frame dent", "Bottom: Frame scratch"];
  const lines = M.cosmeticLines(many);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("COSMETIC  Front:"));
  assert.ok(lines[0].length <= 88, "whole groups to a line while they fit");
  many.forEach(g => assert.equal(lines.filter(l => l.includes(g)).length, 1, "each group sits whole on one line: " + g));
  assert.ok(many.some(g => lines[1].startsWith(g)), "the second line starts with a whole group");
  const out = M.labelHTML(Object.assign({}, M.docs(ROW).label, { verdict: "PASS", faults: [], cosmetic: many }), "unit");
  const bar = +out.match(/class="bars" style="height:([0-9.]+)mm"/)[1];
  assert.ok(bar >= 6 && bar < 7.4, "barcodes give up a little room, not their readability: " + bar);
  // nothing may reach below the footer rule: 2.4 + 9 + 5.3 + 6.6 box + lines + two barcodes with numbers
  const used = 2.4 + 9 + 5.3 + 6.6 + (0.95 + 2 * 2.15 + 0.8) + 2 * (bar + 2.9) + 0.8;
  assert.ok(used <= 49.3 + 0.01, "fits above the footer: " + used.toFixed(2));
});

test("a test saved before the label carried the marks still prints them", () => {
  const row = clone(ROW);
  row.defects = "Frame scratch (Right); Frame scratch (Right)"; row.snapshot.defects = row.defects;
  assert.deepEqual(M.docs(row).label.cosmetic, ["Right: Frame scratch ×2"], "worked out from its saved list of marks");
  delete row.snapshot.print;
  assert.deepEqual(M.docs(row).label.cosmetic, ["Right: Frame scratch ×2"], "and when the printouts are rebuilt");
  const kept = clone(ROW);
  kept.snapshot.print.label.cosmetic = ["Back: Dent"];
  kept.defects = "Frame scratch (Right)";
  assert.deepEqual(M.docs(kept).label.cosmetic, ["Back: Dent"], "the Mac's own groups win when it saved them");
});

test("the box label carries the IMEI barcode, the grade, the port and the SKU", () => {
  const out = M.labelHTML(M.docs(ROW).label, "box");
  assert.ok(out.includes('class="pl box"'));
  assert.equal((out.match(/<svg/g) || []).length, 1);
  assert.ok(out.includes("S/N F7QTEST12ABC"));
  assert.ok(out.includes("IP-12PRO-128-??"));
  assert.match(M.labelCSS("box"), /@page\{size:57mm 32mm;margin:0\}/);
  assert.match(M.labelCSS("unit"), /@page\{size:101mm 54mm;margin:0\}/);
});

test("nothing from a record reaches a printout as markup", () => {
  const u = Object.assign({}, M.docs(ROW).label, { model: '<img src=x onerror=alert(1)>', faults: ['✗ "><script>x</script>'] });
  const out = M.labelHTML(u, "unit") + M.labelHTML(u, "box");
  assert.ok(!out.includes("<img"), "no element from the record");
  assert.ok(!out.includes("<script"));
  const row = clone(ROW);
  row.snapshot.print.report.blockers = ["<b onmouseover=x>bad</b>"];
  row.notes = "<script>1</script>";
  const page = M.reportHTML(M.docs(row), {}) + M.detailHTML(M.flat(row), {});
  assert.ok(!page.includes("<b onmouseover"));
  assert.ok(!page.includes("<script>1"));
});

const ENV = { logo: "logo_light.png", qr: url => "<svg data-url='" + url + "'></svg>",
              verifyURL: (serial, id) => "https://portal.test/?verify=" + serial + "&t=" + id };

test("no certificate is ever drawn for a phone the Mac did not pass", () => {
  const out = M.certificateHTML(M.docs(ROW), ENV);
  assert.ok(out.includes("No certificate for this test"));
  assert.ok(out.includes("This phone is FAIL"), "and it says why");
  assert.ok(!out.includes("PASSED"));
  // Even a record doctored to say "pass" has none unless the Mac issued one.
  const forged = clone(ROW);
  forged.result = "pass"; forged.snapshot.result = "pass"; forged.snapshot.print.report.verdict = "pass";
  assert.ok(!M.certificateHTML(M.docs(forged), ENV).includes("PASSED"));
});

const CERT = { serial: "F7QTEST12ABC", imei: "350000000000006", model: "iPhone 14", modelNumber: "MPUF3LL/A",
  capacity: "128 GB", colour: "Midnight", ios: "26.1", sku: "IP-14-128-PE-MN-A", grade: "A",
  gradeMeaning: "Excellent: like new, no visible marks.", battery: "91%", cycles: "212 (rated 80% at 500)",
  peakTemp: "34 °C on the bench", parts: "All genuine Apple parts", locks: "iCloud off · no customer MDM",
  sim: "Physical SIM + eSIM", checks: ["Motion (accel + gyro)", "Wi-Fi", "Bluetooth"], port: "6",
  tech: "Administrator", warehouse: "YesAgain UAE", erasedOn: "05 Oct 2026", issued: "2026-10-05T10:47:00Z",
  clientUUID: "0123456789abcdef0123456789abcdef" };

test("the certificate the Mac issued is drawn as issued", () => {
  const row = clone(ROW);
  row.snapshot.print.certificate = CERT;
  const out = M.certificateHTML(M.docs(row), ENV);
  assert.ok(out.includes("PASSED"));
  assert.ok(out.includes("GRADE A"));
  assert.ok(out.includes("3 checks passed"));
  assert.ok(out.includes("Certificate YC-F7QTEST12ABC-261005-1447"), "id and time in the Mac's own time zone (Asia/Dubai)");
  assert.ok(out.includes("Issued 05 Oct 2026, 14:47"));
  assert.ok(out.includes("verify=F7QTEST12ABC&amp;t=0123456789abcdef0123456789abcdef") ||
            out.includes("verify=F7QTEST12ABC&t=0123456789abcdef0123456789abcdef"), "QR pinned to this exact test");
  assert.ok(out.includes("Data erased 05 Oct 2026"));
  assert.ok(out.includes("Tested on bench PORT 6, by Administrator, YesAgain UAE."));
});

test("the report says FAILED, gives every reason and never upgrades a test", () => {
  const row = clone(ROW);
  row.snapshot.print.report.tests.push({ name: "Camera Control", result: "", note: "" });
  const out = M.reportHTML(M.docs(row), ENV);
  assert.ok(out.includes(">FAILED<"));
  assert.ok(out.includes("Display repair not finished") || out.includes("Repair not finished: Display"));
  assert.ok(out.includes("4 hardware-fault panics on record"));
  assert.ok(out.includes("NOT DONE"), "a test with no result says so");
  assert.ok(out.includes("SKIPPED"), "a skipped test says so");
  assert.ok(out.includes("YR-F7QTEST12ABC-261005-2210"), "report id as on the Mac's printout");
  assert.ok(out.includes("Fitted parts (serial numbers)"));
  assert.ok(out.includes("Carrier lock"));
  assert.ok(out.includes("Probe 1.7 (49)"));
});

test("a report shows the phone's other tests only when there are any", () => {
  const d = M.docs(ROW);
  assert.ok(!M.reportHTML(d, ENV).includes("Every test on record"));
  const out = M.reportHTML(d, Object.assign({}, ENV, { history: [
    { when: "05 Oct 2026 15:58", result: "REVIEW", grade: "", tech: "Ann", why: "the bench app closed" },
    { when: "05 Oct 2026 22:10", result: "FAIL", grade: "", tech: "Ann", why: "phone left the bench", current: true }] }));
  assert.ok(out.includes("Every test on record for this phone — 2"));
  assert.ok(out.includes("the bench app closed"), "the earlier test stays visible");
  assert.ok(out.includes("this report"));
});

test("an opened record shows the report's own sections", () => {
  const out = M.detailHTML(M.flat(ROW), { tested: "05 Oct 2026 22:10", history: "<div>HIST</div>", loaded: true });
  ["Battery", "Locks &amp; network", "Crash log &amp; bench", "Apple's Parts &amp; Service check", "Fitted parts (serial numbers)",
   "Tests on the phone — 32 passed · 1 failed", "Saved because", "phone left the bench", "Probe 1.7 (49)",
   "Changed since the previous test of this phone", "HIST"].forEach(s => assert.ok(out.includes(s), s));
  assert.ok(out.includes('class="pill FAIL"'));
});

test("a record that could not be loaded says so instead of looking old", () => {
  const slim = M.flat(unslim(slimOf(ROW)));
  const out = M.detailHTML(slim, { loaded: false });
  assert.match(out, /could not be loaded/);
  assert.doesNotMatch(out, /saved before the printouts were kept/);
});

test("the Excel export keeps an IMEI as text and a battery figure as a number", () => {
  const rows = M.exportRows([M.flat(ROW)], { tested: () => "2026-10-05 22:10" });
  const head = rows[0], line = rows[1];
  const col = name => line[head.indexOf(name)];
  assert.equal(typeof col("IMEI"), "string");
  assert.equal(col("IMEI"), "350000000000006");
  assert.equal(col("Battery health %"), 100);
  assert.equal(col("Carrier lock"), "unlocked (Settings: no SIM restrictions)");
  assert.equal(col("iCloud lock"), "off");
  assert.equal(col("Saved because"), "phone left the bench");
  assert.equal(col("Tested"), "2026-10-05 22:10");
  assert.equal(head.length, line.length);
});

// ------------------------------------------------------------------- wiring in the page
function page(extra) {
  const ctx = Object.assign({ console, JSON, Object, Array, String, Map, Set, Promise, encodeURIComponent,
    YCMobile: M, SUPA: "https://supa.test", KEY: "anon-key" }, extra || {});
  vm.createContext(ctx);
  return ctx;
}

test("opening a phone record never asks for a `details` column, nor switches it off for MacBooks", async () => {
  const urls = [];
  const ctx = page({ fetch: async url => { urls.push(url);
    return { ok: true, json: async () => [{ snapshot: { print: {} }, changes_from_previous: { grade: { from: "A", to: "" } } }] }; } });
  vm.runInContext("var MODE='mobile', DETAILS_COL=true;", ctx);
  vm.runInContext(extractFn(html, "ensureSnapshot"), ctx);
  const row = { id: "abc", _raw: { id: "abc", snapshot: { model: "iPhone 14" } } };
  await ctx.ensureSnapshot(row);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes("/mobile_audits?"));
  assert.ok(!urls[0].includes("details"), urls[0]);
  assert.equal(vm.runInContext("DETAILS_COL", ctx), true, "the MacBook table still gets asked for its details");
  assert.equal(row._raw._full, true);
  assert.equal(row._raw.snapshot.model, "iPhone 14", "what the list already had is kept");
  assert.deepEqual(row._raw.changes_from_previous, { grade: { from: "A", to: "" } });
});

test("the list uses the stored columns when the database has them, and asks only once", async () => {
  let calls = 0;
  const ctx = page({ fetch: async () => { calls++; return { ok: true, status: 200 }; } });
  vm.runInContext("var MOBILE_STORED=null;", ctx);
  vm.runInContext(extractFn(html, "mobileListSelect"), ctx);
  assert.equal(await ctx.mobileListSelect(), M.listSelect(true));
  assert.equal(await ctx.mobileListSelect(), M.listSelect(true));
  assert.equal(calls, 1);
});

test("without the stored columns it reads the snapshot fields instead — the page never depends on the script", async () => {
  const ctx = page({ fetch: async () => ({ ok: false, status: 400 }) });
  vm.runInContext("var MOBILE_STORED=null;", ctx);
  vm.runInContext(extractFn(html, "mobileListSelect"), ctx);
  assert.equal(await ctx.mobileListSelect(), M.listSelect(false));
});

test("a store that is merely slow or down decides nothing about the columns", async () => {
  let n = 0;
  const ctx = page({ fetch: async () => { n++; if (n === 1) throw new Error("offline"); return n === 2 ? { ok: false, status: 503 } : { ok: true, status: 200 }; } });
  vm.runInContext("var MOBILE_STORED=null;", ctx);
  vm.runInContext(extractFn(html, "mobileListSelect"), ctx);
  assert.equal(await ctx.mobileListSelect(), M.listSelect(false), "offline: the always-working query");
  assert.equal(await ctx.mobileListSelect(), M.listSelect(false), "503: still undecided");
  assert.equal(await ctx.mobileListSelect(), M.listSelect(true), "and it asks again until it gets a real answer");
});

test("several labels cost one request, not one each", async () => {
  const urls = [];
  const ctx = page({ fetch: async url => { urls.push(url);
    return { ok: true, json: async () => [{ id: "a", snapshot: { print: 1 } }, { id: "b", snapshot: { print: 2 } }] }; } });
  vm.runInContext(extractFn(html, "ensureSnapshots"), ctx);
  const rows = [{ _raw: { id: "a", snapshot: {} } }, { _raw: { id: "b", snapshot: {} } }, { _raw: { id: "c", snapshot: {}, _full: true } }];
  await ctx.ensureSnapshots(rows);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes("id=in.(a,b)"), "only the two that were not loaded yet");
  assert.equal(rows[0]._raw._full, true);
  assert.equal(rows[1]._raw.snapshot.print, 2);
});

test("a phone label is never printed from a record that did not load", async () => {
  const said = [];
  let printed = 0;
  const ctx = page({ fetch: async () => { throw new Error("offline"); }, alert: m => said.push(m),
    printInFrame: () => { printed++; }, phoneLabelId: () => "unit" });
  ["ensureSnapshots", "phoneRecordsLoaded", "printPhoneLabels"].forEach(f => vm.runInContext(extractFn(html, f), ctx));
  await ctx.printPhoneLabels([{ _raw: { id: "a", snapshot: { model: "iPhone 14" } } }]);
  assert.equal(printed, 0);
  assert.match(said[0], /Couldn't load this record/);
});

test("in the phones view every print path draws the phone's own label", () => {
  let phone = 0;
  const ctx = page({ printPhoneLabels: () => { phone++; }, curLabelSize: () => { throw new Error("a MacBook label was about to be drawn"); } });
  vm.runInContext("var MODE='mobile';", ctx);
  vm.runInContext(extractFn(html, "printLabels"), ctx);
  ctx.printLabels([{ id: 1 }]);
  assert.equal(phone, 1);
});

test("the analysis counts a phone's faults by name, not by sentence", () => {
  const ctx = page();
  vm.runInContext(extractFn(html, "splitFaults"), ctx);
  assert.deepEqual(ctx.splitFaults({ faults: "Battery health 74% — below the 85% floor", fault_tags: ["Battery health below the floor"] }),
    ["Battery health below the floor"]);
  assert.deepEqual([...ctx.splitFaults({ faults: "Fan / thermal fault (noisy); RAM fault" })], ["Fan / thermal fault", "RAM fault"],
    "a MacBook row is split as before");
});

test("the page's phone columns escape what they show", () => {
  const src = html.slice(html.indexOf("const MOBILECOLS=["), html.indexOf("const MOBILE_DEFAULT_VIS="));
  const raw = [...src.matchAll(/\$\{(r\.[a-z_]+)(\|\|[^}]*)?\}/g)].map(m => m[1]);
  assert.deepEqual(raw, [], "every value goes through escv: " + raw.join(", "));
});
