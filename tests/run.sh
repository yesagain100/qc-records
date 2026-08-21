#!/bin/bash
# Portal test suite: unit tests, then a lot built through the page's own code path,
# exported, and re-opened by a real spreadsheet reader.
set -e
cd "$(dirname "$0")/.."
node --test tests/*.test.js
node tests/make_workbook.js /tmp/yc_lot_test.xlsx
python3 tests/validate_xlsx.py /tmp/yc_lot_test.xlsx
