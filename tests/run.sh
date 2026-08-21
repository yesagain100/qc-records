#!/bin/bash
# Portal test suite: unit tests, then a generated workbook re-opened by a real reader.
set -e
cd "$(dirname "$0")/.."
node --test tests/*.test.js
node -e '
const {buildXlsx}=require("./xlsx.js"),fs=require("fs");
fs.writeFileSync("/tmp/yc_lot_test.xlsx", Buffer.from(buildXlsx([
 {name:"Details",rows:[["Serial","Model","Supplier grade","Goods In","Screen","Battery %"],
  ["C02ABC123","MacBook Pro 13","B","A","A",91],
  ["C02DEF456","شاشة مكسورة","C","B","C",84],
  ["C02NOTTESTED",null,null,null,null,null]]},
 {name:"Summary",rows:[["Metric","Value"],["Units in lot",3]]}])));'
python3 tests/validate_xlsx.py /tmp/yc_lot_test.xlsx
