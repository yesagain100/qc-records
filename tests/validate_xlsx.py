"""Open a workbook written by xlsx.js with a real spreadsheet reader.

The writer is hand-rolled, so "it produced bytes" proves nothing — Excel's rules
(zip layout, relationship ids, inline strings, cell refs) have to actually hold.
Fed by tests/run.sh with a lot built through the same code path the page uses.
"""
import sys
import openpyxl

wb = openpyxl.load_workbook(sys.argv[1])
assert wb.sheetnames == ["Details", "Summary"], wb.sheetnames

d = wb["Details"]
hdr = [c.value for c in d[1]]
for col in ("Serial", "Supplier grade", "Goods In grade", "Screen grade", "Overall grade"):
    assert col in hdr, "%s missing from %s" % (col, hdr)

body = {r[0].value: [c.value for c in r] for r in d.iter_rows(min_row=2)}
assert d.max_row == 4, "3 units expected, got %d rows" % (d.max_row - 1)

tested = body["C02ABC123"]
assert tested[hdr.index("Overall grade")] == "C"
assert tested[hdr.index("Supplier grade")] == "B"
assert tested[hdr.index("Grade check")] == "supplier B → C"
assert tested[hdr.index("Battery %")] == 91, repr(tested[hdr.index("Battery %")])
assert isinstance(tested[hdr.index("Battery %")], int), "a number must stay numeric"

untested = body["C02NEVER"]
assert untested[hdr.index("Result")] == "NOT TESTED"
assert untested[hdr.index("Supplier grade")] == "A"
assert untested[hdr.index("Overall grade")] is None, "no grade for a unit never tested"

arabic = body["C02DEF456"]
assert arabic[hdr.index("Faults")] == "شاشة مكسورة", arabic[hdr.index("Faults")]

s = wb["Summary"]
figures = {r[0].value: r[1].value for r in s.iter_rows(min_row=1) if r[0].value}
assert figures["Units in lot"] == 3, figures
assert figures["Tested"] == 2
assert figures["Not tested"] == 1
assert figures["Fail / reject"] == 1
assert figures["Defect rate (% of tested)"] == 50

print("workbook OK —", wb.sheetnames, "| Details rows:", d.max_row - 1,
      "| defect rate:", figures["Defect rate (% of tested)"])
