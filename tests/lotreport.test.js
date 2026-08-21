const { test } = require("node:test");
const assert = require("node:assert");
const { lotRows, lotSummary, normSerial, gradeMatch } = require("../lotreport.js");

// A tested unit as the portal shapes it (see mapRow in index.html).
function unit(o) {
  return Object.assign({
    serial: "", model: "", grade: "", display_grade: "", body_grade: "", result: "PASS",
    batt_h: null, batt_c: null, faults: "", tech_disp: "", warehouse: "", department: "",
    lot_id: "LOT1", po: "", supplier: "", sku: "", memory: null, storage: null,
    tested_at: "2026-08-01T10:00:00Z"
  }, o);
}
function supplierRow(o) {
  return Object.assign({ serial: "", supplier_grade: "", supplier_model: "",
                         supplier_ram: "", supplier_ssd: "", lot_id: "LOT1" }, o);
}

test("serial normalisation matches the engine's", () => {
  assert.equal(normSerial(" c02-abc 123 "), "C02ABC123");
  assert.equal(normSerial(null), "");
});

test("a supplier serial with no test appears as NOT TESTED", () => {
  const rows = lotRows({
    units: [], supplierRows: [supplierRow({ serial: "C02AAA", supplier_grade: "B" })],
    audits: [], lotId: "LOT1"
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tested, false);
  assert.equal(rows[0].result, "NOT TESTED");
  assert.equal(rows[0].supplierGrade, "B");
  assert.equal(rows[0].overallGrade, "");
});

test("a tested unit missing from the sheet still appears, with no supplier grade", () => {
  const rows = lotRows({
    units: [unit({ serial: "C02BBB", grade: "C" })], supplierRows: [], audits: [], lotId: "LOT1"
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tested, true);
  assert.equal(rows[0].supplierGrade, "");
  assert.equal(rows[0].overallGrade, "C");
});

test("the sheet and the tested units are unioned, not concatenated", () => {
  const rows = lotRows({
    units: [unit({ serial: "c02aaa", grade: "C" })],
    supplierRows: [supplierRow({ serial: "C02-AAA", supplier_grade: "B" })],
    audits: [], lotId: "LOT1"
  });
  assert.equal(rows.length, 1, "one row, matched despite case and punctuation");
  assert.equal(rows[0].supplierGrade, "B");
  assert.equal(rows[0].overallGrade, "C");
});

test("screen grade is the display grade", () => {
  const rows = lotRows({
    units: [unit({ serial: "C02AAA", grade: "C", display_grade: "B", body_grade: "C" })],
    supplierRows: [], audits: [], lotId: "LOT1"
  });
  assert.equal(rows[0].screenGrade, "B");
});

test("goods-in grade comes from the latest audit by a goods-in group", () => {
  const audits = [
    { serial: "C02AAA", department: "goods_in", grade: "B", tested_at: "2026-08-01T09:00:00Z" },
    { serial: "C02AAA", department: "goods_in", grade: "C", tested_at: "2026-08-02T09:00:00Z" },
    { serial: "C02AAA", department: "qc", grade: "A", tested_at: "2026-08-03T09:00:00Z" }
  ];
  const rows = lotRows({
    units: [unit({ serial: "C02AAA", grade: "A" })], supplierRows: [], audits,
    lotId: "LOT1", goodsInGroups: ["goods_in"]
  });
  assert.equal(rows[0].goodsInGrade, "C", "latest goods-in test, not the latest test");
  assert.equal(rows[0].overallGrade, "A");
});

test("goods-in grade is blank when no goods-in test exists", () => {
  const rows = lotRows({
    units: [unit({ serial: "C02AAA", grade: "A" })], supplierRows: [],
    audits: [{ serial: "C02AAA", department: "qc", grade: "A", tested_at: "2026-08-03T09:00:00Z" }],
    lotId: "LOT1", goodsInGroups: ["goods_in"]
  });
  assert.equal(rows[0].goodsInGrade, "");
});

test("goods-in matching ignores case and spacing of the group name", () => {
  const rows = lotRows({
    units: [unit({ serial: "C02AAA" })], supplierRows: [],
    audits: [{ serial: "C02AAA", department: " Goods_In ", grade: "D", tested_at: "2026-08-01T09:00:00Z" }],
    lotId: "LOT1", goodsInGroups: ["goods_in"]
  });
  assert.equal(rows[0].goodsInGrade, "D");
});

test("supplier grade against tested grade is flagged when they differ", () => {
  assert.equal(gradeMatch("B", "B"), "match");
  assert.equal(gradeMatch("B", "C"), "supplier B → C");
  assert.equal(gradeMatch("", "C"), "");
  assert.equal(gradeMatch("B", ""), "");
  assert.equal(gradeMatch("b", "B"), "match", "case is not a mismatch");
});

test("rows are sorted by serial so an export is stable between runs", () => {
  const rows = lotRows({
    units: [unit({ serial: "C02ZZZ" }), unit({ serial: "C02AAA" })],
    supplierRows: [], audits: [], lotId: "LOT1"
  });
  assert.deepEqual(rows.map(r => r.serial), ["C02AAA", "C02ZZZ"]);
});

test("summary counts untested separately from defective", () => {
  const rows = lotRows({
    units: [unit({ serial: "C02AAA", result: "PASS", grade: "A" }),
            unit({ serial: "C02BBB", result: "FAIL", grade: "D", faults: "Screen crack" })],
    supplierRows: [supplierRow({ serial: "C02AAA" }), supplierRow({ serial: "C02BBB" }),
                   supplierRow({ serial: "C02CCC" })],
    audits: [], lotId: "LOT1"
  });
  const s = lotSummary(rows);
  assert.equal(s.total, 3);
  assert.equal(s.tested, 2);
  assert.equal(s.notTested, 1);
  assert.equal(s.defective, 1);
  assert.equal(s.defectRate, 50, "rate is over TESTED units, not the whole lot");
});

test("defect rate is zero, not NaN, when nothing was tested", () => {
  const rows = lotRows({
    units: [], supplierRows: [supplierRow({ serial: "C02AAA" })], audits: [], lotId: "LOT1"
  });
  const s = lotSummary(rows);
  assert.equal(s.defectRate, 0);
  assert.equal(s.notTested, 1);
});

test("summary tallies the overall grade spread", () => {
  const rows = lotRows({
    units: [unit({ serial: "C02AAA", grade: "A" }), unit({ serial: "C02BBB", grade: "A" }),
            unit({ serial: "C02CCC", grade: "C" })],
    supplierRows: [], audits: [], lotId: "LOT1"
  });
  const s = lotSummary(rows);
  assert.equal(s.grades.A, 2);
  assert.equal(s.grades.C, 1);
});

test("only the requested lot's units are included", () => {
  const rows = lotRows({
    units: [unit({ serial: "C02AAA", lot_id: "LOT1" }), unit({ serial: "C02BBB", lot_id: "LOT2" })],
    supplierRows: [supplierRow({ serial: "C02CCC", lot_id: "LOT2" })],
    audits: [], lotId: "LOT1"
  });
  assert.deepEqual(rows.map(r => r.serial), ["C02AAA"]);
});

test("a row with no serial is dropped rather than creating a blank line", () => {
  const rows = lotRows({
    units: [unit({ serial: "" })], supplierRows: [supplierRow({ serial: "  " })],
    audits: [], lotId: "LOT1"
  });
  assert.equal(rows.length, 0);
});

test("the Details sheet leads with a header row and one row per unit", () => {
  const rows = lotRows({
    units: [unit({ serial: "C02BBB", grade: "C", result: "FAIL" })],
    supplierRows: [supplierRow({ serial: "C02AAA", supplier_grade: "B" }),
                   supplierRow({ serial: "C02BBB", supplier_grade: "B" })],
    audits: [], lotId: "LOT1"
  });
  const sheet = require("../lotreport.js").lotDetailSheet(rows, "LOT1");
  assert.equal(sheet.length, 3, "header + two units");
  assert.equal(sheet[0][0], "Serial");
  assert.equal(sheet[0][3], "Supplier grade");
  assert.equal(sheet[0][4], "Goods In grade");
  assert.equal(sheet[1][0], "C02AAA");
  assert.equal(sheet[1][9], "NOT TESTED");
});

test("battery is capped at 100 in the export, as it is on screen", () => {
  const rows = lotRows({
    units: [unit({ serial: "C02AAA", batt_h: 103 })], supplierRows: [], audits: [], lotId: "LOT1"
  });
  const sheet = require("../lotreport.js").lotDetailSheet(rows, "LOT1");
  assert.equal(sheet[1][10], 100);
});

test("the Summary sheet carries the figures and the breakdowns", () => {
  const rows = lotRows({
    units: [unit({ serial: "C02AAA", grade: "A", result: "PASS" }),
            unit({ serial: "C02BBB", grade: "D", result: "FAIL", faults: "Screen crack; Dead pixel" })],
    supplierRows: [supplierRow({ serial: "C02CCC" })], audits: [], lotId: "LOT1"
  });
  const sheet = require("../lotreport.js").lotSummarySheet(rows, "LOT1", "now");
  const find = k => (sheet.find(r => r[0] === k) || [])[1];
  assert.equal(find("Lot"), "LOT1");
  assert.equal(find("Units in lot"), 3);
  assert.equal(find("Not tested"), 1);
  assert.equal(find("Fail / reject"), 1);
  assert.equal(find("Defect rate (% of tested)"), 50);
  assert.equal(find("Screen crack"), 1, "faults are broken down");
  assert.equal(find("A"), 1, "grades are broken down");
});
