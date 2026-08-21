// Build a lot the way the page does — lotRows -> lotDetailSheet/lotSummarySheet ->
// buildXlsx — so validate_xlsx.py checks the real export path, not a hand-made fixture.
const { lotRows, lotDetailSheet, lotSummarySheet } = require("../lotreport.js");
const { buildXlsx } = require("../xlsx.js");
const fs = require("fs");

const units = [
  { serial: "C02ABC123", model: "MacBook Pro 13", grade: "C", display_grade: "B",
    body_grade: "C", result: "PASS", batt_h: 91, batt_c: 210, faults: "",
    tech_disp: "Ann", warehouse: "UAE", department: "qc", lot_id: "LOT1",
    po: "PO-1", supplier: "ALCHEMY", sku: "MBP13", memory: 8, storage: 256,
    tested_at: "2026-08-01T10:00:00Z" },
  { serial: "C02DEF456", model: "MacBook Air", grade: "D", display_grade: "D",
    body_grade: "C", result: "FAIL", batt_h: 84, batt_c: 640,
    faults: "شاشة مكسورة", tech_disp: "Bob", warehouse: "UAE", department: "qc",
    lot_id: "LOT1", po: "PO-1", supplier: "ALCHEMY", sku: "MBA13", memory: 16,
    storage: 512, tested_at: "2026-08-02T10:00:00Z" }
];
const supplierRows = [
  { serial: "C02ABC123", supplier_grade: "B", lot_id: "LOT1" },
  { serial: "C02DEF456", supplier_grade: "D", lot_id: "LOT1" },
  { serial: "C02NEVER", supplier_grade: "A", supplier_model: "MacBook Pro 16", lot_id: "LOT1" }
];
const audits = [
  { serial: "C02ABC123", department: "goods_in", grade: "B", tested_at: "2026-07-30T09:00:00Z" }
];

const rows = lotRows({ units, supplierRows, audits, lotId: "LOT1", goodsInGroups: ["goods_in"] });
fs.writeFileSync(process.argv[2], Buffer.from(buildXlsx([
  { name: "Details", rows: lotDetailSheet(rows, "LOT1") },
  { name: "Summary", rows: lotSummarySheet(rows, "LOT1", "2026-08-21 12:00") }
])));
console.log("wrote", process.argv[2], "-", rows.length, "units");
