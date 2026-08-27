// The deployable bundle must be the same portal, not merely valid JavaScript. These run
// the bundle's own inlined code, and fail if dist/ is stale relative to source.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
execFileSync(path.join(root, "build.sh"), { cwd: root });        // always test a fresh build
const dist = fs.readFileSync(path.join(root, "dist", "index.html"), "utf8");

test("no sibling script is left to 404 on a single-file host", () => {
  const srcs = [...dist.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(srcs.filter(s => !/^https?:/.test(s)), [],
    "every local script must be inlined");
});

test("the three modules are actually present in the bundle", () => {
  ["lotreport.js", "xlsx.js", "certificate.js"].forEach(n =>
    assert.ok(dist.includes("/* inlined from " + n + " */"), n + " inlined"));
});

test("the bundle's own copies of the modules still work", () => {
  // Mirror a browser: xlsx.js encodes via TextEncoder there and only falls back to
  // Buffer under Node, so a bare sandbox would exercise a path the portal never takes.
  const ctx = { window: {}, console, TextEncoder, Uint8Array, Int32Array };
  vm.createContext(ctx);
  // Evaluate every inline block that defines a module, then use it.
  [...dist.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1])
    .filter(b => b.includes("/* inlined from "))
    .forEach(b => vm.runInContext(b, ctx));

  const L = ctx.window.YCLotReport, X = ctx.window.YCXlsx, C = ctx.window.YCCertificate;
  assert.ok(L && X && C, "all three modules attach to window");

  const rows = L.lotRows({
    units: [], supplierRows: [{ serial: "C02AAA", supplier_grade: "B", lot_id: "L1" }],
    audits: [], lotId: "L1"
  });
  assert.equal(rows[0].result, "NOT TESTED", "lot logic works from the bundle");

  const book = X.buildXlsx([{ name: "S", rows: [["a"]] }]);
  assert.equal(book[0], 0x50, "the workbook writer works from the bundle");

  const cert = C.certificateRows({ details: { checklist: [
    { id: "a", label: "A", group: "G", state: "na" } ] } });
  assert.equal(cert.groups[0].items[0].state, "na", "certificate shaping works from the bundle");
});

test("the label duplication is gone from the deployed copy too", () => {
  assert.ok(!/flatMap\(r=>\[labelHTML\(r\),labelHTML\(r\)\]\)/.test(dist));
});

test("logos stay relative so they resolve beside the page", () => {
  assert.ok(dist.includes('src="logo_orange.png"'));
  assert.ok(fs.existsSync(path.join(root, "dist", "logo_orange.png")));
  assert.ok(fs.existsSync(path.join(root, "dist", "logo_white.png")));
});
