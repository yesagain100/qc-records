// Renders the certificate function lifted straight out of index.html, with the page's
// helpers stubbed. Catches what a unit test on certificate.js cannot: a typo'd variable
// or a helper that does not exist in the page.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");

function extractFn(src, name) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start > -1, name + " not found in index.html");
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const ctx = {
  YCCertificate: require("../certificate.js"),
  lblEsc: v => String(v == null ? "" : v),
  certId: () => "YC-TEST",
  certQRSvg: () => "<svg></svg>",
  certVerifyURL: () => "https://example/verify",
  fmtTested: () => "1 Aug 2026",
  console
};
vm.createContext(ctx);
vm.runInContext(extractFn(html, "testCertHTML"), ctx);

const unit = {
  serial: "C02ABC", model: "MacBook Pro 13", result: "FAIL", grade: "D",
  display_grade: "D", body_grade: "B", batt_h: 88, batt_c: 300, chip: "Apple M1",
  memory: 8, storage: 256, tech_disp: "Ann", warehouse: "UAE", department: "qc",
  faults: "Screen crack",
  _raw: { snapshot: { model_identifier: "MacBookPro17,1", details: {
    checklist: [
      { id: "wifi", label: "Wi-Fi", group: "Wireless", state: "pass" },
      { id: "bt", label: "Bluetooth", group: "Wireless", state: "fail" },
      { id: "tb", label: "Touch Bar", group: "Keyboard", state: "na" },
      { id: "cam", label: "Camera", group: "Sensors", state: "untested" }
    ],
    thermal: { ran: true, duration_s: 90, verdict: "PASS",
               bands: [{ label: "Peak CPU", value: "97", unit: "°C" }] },
    ram: { ran: false }
  } } }
};

test("renders for a FAILED unit — the component detail matters most there", () => {
  const out = ctx.testCertHTML(unit);
  assert.ok(out.includes("Component Test Certificate"));
  assert.ok(out.includes("FAIL"));
  assert.ok(!/Certificates are issued for PASSED units only/.test(out));
});

test("states are printed as themselves, never upgraded", () => {
  const out = ctx.testCertHTML(unit);
  assert.ok(out.includes("N/A"), "an N/A item says N/A");
  assert.ok(out.includes("NOT TESTED"), "an untested item says NOT TESTED");
  assert.ok(out.includes("Touch Bar"));
  assert.ok(out.includes("Camera"));
});

test("a not-run automated test is reported as NOT RUN", () => {
  const out = ctx.testCertHTML(unit);
  assert.ok(out.includes("NOT RUN"));
  assert.ok(out.includes("RUN — 1m 30s"));
  assert.ok(out.includes("Peak CPU"), "measured readings are carried");
});

test("a pre-checklist record explains itself instead of drawing an empty table", () => {
  const old = JSON.parse(JSON.stringify(unit));
  delete old._raw.snapshot.details.checklist;
  const out = ctx.testCertHTML(old);
  assert.ok(/Per-item detail was not captured/.test(out));
  assert.ok(out.includes("NOT RUN"), "the automated block still renders");
});

test("a record with no snapshot at all does not throw", () => {
  assert.doesNotThrow(() => ctx.testCertHTML({ serial: "X", result: "PASS" }));
});

test("counts summarise the checks on the face of the document", () => {
  const out = ctx.testCertHTML(unit);
  assert.ok(out.includes("1/4"), "1 of 4 checks passed");
  assert.ok(out.includes("1 failed"));
});

// ---- lot report table ------------------------------------------------------
// Same idea: run the page's own renderer against stubbed globals so the table's
// wiring is covered, not just the row maths.
function lotContext() {
  const host = { innerHTML: "", style: {} };
  const pick = { onchange: null, value: "" };
  const c = {
    YCLotReport: require("../lotreport.js"),
    document: { getElementById: id => (id === "lotTab" ? host : pick) },
    escv: v => String(v == null ? "" : v),
    fmtDate: d => String(d || "").slice(0, 10),
    dchip: d => String(d || "—").slice(0, 10),
    bars: () => "<div class='bars'></div>",
    isTest: () => false,
    console, _host: host
  };
  vm.createContext(c);
  // var, not let: let bindings are not properties of the context object, so a
  // test could not seed them from outside.
  vm.runInContext("var LOT_SEL='', LOTROWS=[], LOT_SERIALS=[], RAW=[];", c);
  ["latestPerSerial", "lotBase", "lotAllRows", "renderLotReport"]
    .forEach(f => vm.runInContext(extractFn(html, f), c));
  vm.runInContext('var GOODS_IN_GROUPS=["goods_in"];', c);
  return c;
}

test("the lot table lists every unit, tested or not", () => {
  const c = lotContext();
  c.LOT_SERIALS = [{ serial: "C02AAA", supplier_grade: "B", lot_id: "L1" },
                   { serial: "C02NEVER", supplier_grade: "A", lot_id: "L1" }];
  c.RAW = [{ serial: "C02AAA", lot_id: "L1", grade: "C", display_grade: "B", result: "PASS",
             tested_at: "2026-08-01T10:00:00Z", _raw: {} }];
  vm.runInContext("LOT_SEL='L1'; renderLotReport();", c);
  const out = c._host.innerHTML;
  assert.ok(out.includes("C02AAA"), "the tested unit is listed");
  assert.ok(out.includes("C02NEVER"), "the never-tested unit is listed too");
  assert.ok(out.includes("NOT TESTED"));
  assert.ok(out.includes("All units — Lot L1"));
});

test("the four grade columns are on the table", () => {
  const c = lotContext();
  c.LOT_SERIALS = [{ serial: "C02AAA", supplier_grade: "B", lot_id: "L1" }];
  c.RAW = [{ serial: "C02AAA", lot_id: "L1", grade: "C", display_grade: "B", result: "PASS",
             tested_at: "2026-08-01T10:00:00Z", _raw: {} }];
  vm.runInContext("LOT_SEL='L1'; renderLotReport();", c);
  const out = c._host.innerHTML;
  ["Supplier", "Goods In", "Screen", "Overall"].forEach(h =>
    assert.ok(out.includes("<th>" + h + "</th>"), h + " column present"));
  assert.ok(out.includes("supplier B → C"), "a supplier/tested disagreement is flagged");
});

test("an untested row is not made clickable", () => {
  const c = lotContext();
  c.LOT_SERIALS = [{ serial: "C02NEVER", lot_id: "L1" }];
  c.RAW = [];
  vm.runInContext("LOT_SEL='L1'; renderLotReport();", c);
  const out = c._host.innerHTML;
  assert.ok(out.includes('class="untested"'));
  assert.ok(!/onclick="openRowObj\(LOTROWS\[0\]/.test(out), "no dead click target");
});

test("the export button offers the full lot, not just defects", () => {
  const c = lotContext();
  c.LOT_SERIALS = [{ serial: "C02AAA", lot_id: "L1" }];
  c.RAW = [];
  vm.runInContext("LOT_SEL='L1'; renderLotReport();", c);
  assert.ok(c._host.innerHTML.includes("Export full lot"));
});

test("a lot with no records at all shows the empty state, not a crash", () => {
  const c = lotContext();
  assert.doesNotThrow(() => vm.runInContext("renderLotReport();", c));
  assert.ok(c._host.innerHTML.includes("No lot numbers"));
});
