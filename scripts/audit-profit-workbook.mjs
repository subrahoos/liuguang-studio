import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";

const workbookPath = process.argv[2];
if (!workbookPath) throw new Error("Usage: node scripts/audit-profit-workbook.mjs <workbook.xlsx>");

const workbook = XLSX.read(readFileSync(workbookPath), { type: "buffer", cellDates: true, cellFormula: true, cellStyles: true });

function normalizeFormula(formula) {
  return String(formula)
    .replace(/(\$?[A-Z]{1,3}\$?)\d+/g, "$1{row}")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function dependencies(formula) {
  const refs = new Set();
  const pattern = /(?:'((?:[^']|'')+)'|([\p{L}\p{N}_\-.]+))!\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?/gu;
  for (const match of String(formula).matchAll(pattern)) refs.add((match[1] || match[2] || "").replace(/''/g, "'"));
  return [...refs];
}

const sheets = workbook.SheetNames.map((name, index) => {
  const sheet = workbook.Sheets[name];
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1:A1");
  const patterns = new Map();
  const refs = new Set();
  let formulaCount = 0;
  let firstFormula = null;
  let lastFormula = null;
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = sheet[address];
      if (!cell?.f) continue;
      formulaCount += 1;
      firstFormula ||= { address, formula: cell.f, value: cell.v ?? null };
      lastFormula = { address, formula: cell.f, value: cell.v ?? null };
      const key = normalizeFormula(cell.f);
      const current = patterns.get(key) || { count: 0, sampleAddress: address, sampleFormula: cell.f };
      current.count += 1;
      patterns.set(key, current);
      for (const dependency of dependencies(cell.f)) refs.add(dependency);
    }
  }
  const headerRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false, range: 0 }).slice(0, 5);
  return {
    name,
    index,
    hidden: workbook.Workbook?.Sheets?.[index]?.Hidden || 0,
    ref: sheet["!ref"] || null,
    rowCount: range.e.r - range.s.r + 1,
    columnCount: range.e.c - range.s.c + 1,
    formulaCount,
    formulaPatternCount: patterns.size,
    dependencies: [...refs],
    autoFilter: sheet["!autofilter"]?.ref || null,
    hiddenRows: (sheet["!rows"] || []).filter((row) => row?.hidden).length,
    mergedRanges: sheet["!merges"]?.length || 0,
    firstFormula,
    lastFormula,
    topFormulaPatterns: [...patterns.values()].sort((a, b) => b.count - a.count).slice(0, 12),
    headerRows,
  };
});

console.log(JSON.stringify({ file: workbookPath, sheetCount: sheets.length, sheets }, null, 2));
