import XLSX from 'xlsx';
import { logger } from '../utils/logger.js';

export interface ParsedReqLine {
  format: string;
  sheetName: string;
  rowNumber: number;
  partNumber: string;
  partRev: string;
  description: string;
  qty: number;
  vendor: string;
  vendorPart: string;
  vendorQty: number;
  unitCost: number;
  destination: string;
  destinationType: 'JO' | 'SO' | 'INV' | 'UNKNOWN';
}

/**
 * Parse an XLSX buffer and return structured requisition lines.
 * Auto-detects format based on sheet names and header structure.
 */
export function parseXlsx(buffer: Buffer, filename: string, issueKey: string): ParsedReqLine[] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    logger.warn(`Failed to parse XLSX ${filename} (${issueKey}): ${err}`);
    return [];
  }

  // Detect format
  if (wb.SheetNames.includes('JomlDump') || wb.SheetNames.includes('Pivot')) {
    return parsePostWoKitting(wb, filename);
  }

  if (wb.SheetNames.some(n => ['8890', '7890', '6890', '6850'].includes(n))) {
    // Extract JO from filename: "W9688 AGILENT GC ORDERING SHEET.xlsx"
    const joMatch = filename.match(/W\d{4,5}/);
    return parseGcOrderingSheet(wb, joMatch?.[0] || '', filename);
  }

  // Check for requisition form header pattern
  const firstSheet = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, { header: 1 });
  for (let i = 0; i < Math.min(15, data.length); i++) {
    const row = data[i] as unknown[];
    if (row && String(row[1] || '').includes('PART NUMBER')) {
      return parseRequisitionForm(wb, data, i, filename);
    }
  }

  // Fallback: look for row with VENDOR/PART headers
  for (let i = 0; i < Math.min(15, data.length); i++) {
    const row = data[i] as unknown[];
    const rowStr = JSON.stringify(row || []).toUpperCase();
    if (rowStr.includes('VENDOR') && (rowStr.includes('PART') || rowStr.includes('WPN'))) {
      return parseRequisitionForm(wb, data, i, filename);
    }
  }

  logger.warn(`Unknown XLSX format for ${filename} (${issueKey}) — sheets: ${wb.SheetNames.join(', ')}`);
  return [];
}

function parsePostWoKitting(wb: XLSX.WorkBook, filename: string): ParsedReqLine[] {
  const lines: ParsedReqLine[] = [];

  // Prefer JomlDump (detailed with JO assignments) over Pivot (summary)
  const sheetName = wb.SheetNames.includes('JomlDump') ? 'JomlDump' : 'Pivot';
  const sheet = wb.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

  if (sheetName === 'JomlDump') {
    // Headers: VENDOR, PART#, REV, DESCRIPTION, Column1, Column2, ActQty, IssuedQty, ExtendedQty, WO#, QTYONORDER, TOTALDEMAND, SAFETY STOCK, COST
    for (let i = 1; i < data.length; i++) {
      const row = data[i] as unknown[];
      if (!row || !row[1]) continue; // skip empty rows

      const partNumber = String(row[1] || '').trim();
      if (!partNumber) continue;

      const dest = String(row[9] || '').trim();
      const qty = toNum(row[8]); // ExtendedQty

      lines.push({
        format: 'post_wo_kitting',
        sheetName,
        rowNumber: i,
        partNumber,
        partRev: String(row[2] || '').trim(),
        description: String(row[3] || '').trim(),
        qty,
        vendor: String(row[0] || '').trim(),
        vendorPart: '',
        vendorQty: 0,
        unitCost: toNum(row[13]),
        destination: dest,
        destinationType: classifyDestination(dest),
      });
    }
  } else {
    // Pivot: VENDOR, PART#, REV, DESCRIPTION, WO#, Qty for WO's, Total Demand, Average of COST
    for (let i = 1; i < data.length; i++) {
      const row = data[i] as unknown[];
      if (!row || !row[1]) continue;

      const partNumber = String(row[1] || '').trim();
      if (!partNumber) continue;

      const dest = String(row[4] || '').trim();

      lines.push({
        format: 'post_wo_kitting',
        sheetName,
        rowNumber: i,
        partNumber,
        partRev: String(row[2] || '').trim(),
        description: String(row[3] || '').trim(),
        qty: toNum(row[5]),
        vendor: String(row[0] || '').trim(),
        vendorPart: '',
        vendorQty: 0,
        unitCost: toNum(row[7]),
        destination: dest,
        destinationType: classifyDestination(dest),
      });
    }
  }

  return lines;
}

function parseGcOrderingSheet(wb: XLSX.WorkBook, joNumber: string, filename: string): ParsedReqLine[] {
  const lines: ParsedReqLine[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

    for (let i = 0; i < data.length; i++) {
      const row = data[i] as unknown[];
      if (!row) continue;

      const qty = toNum(row[0]);
      const wpn = String(row[2] || '').trim();

      // Only include rows with a quantity filled in
      if (qty > 0 && wpn) {
        lines.push({
          format: 'gc_ordering',
          sheetName,
          rowNumber: i,
          partNumber: wpn,
          partRev: '',
          description: String(row[6] || '').trim(),
          qty,
          vendor: 'Agilent',
          vendorPart: String(row[4] || '').trim(),
          vendorQty: qty,
          unitCost: 0,
          destination: joNumber,
          destinationType: joNumber ? 'JO' : 'UNKNOWN',
        });
      }
    }
  }

  return lines;
}

function parseRequisitionForm(
  wb: XLSX.WorkBook,
  data: unknown[][],
  headerRow: number,
  filename: string,
): ParsedReqLine[] {
  const lines: ParsedReqLine[] = [];

  // Try to extract destination from the top rows (WO#, SO#, etc.)
  let destination = '';
  let destinationType: 'JO' | 'SO' | 'INV' | 'UNKNOWN' = 'UNKNOWN';

  for (let i = 0; i < Math.min(headerRow, 10); i++) {
    const row = data[i] as unknown[];
    if (!row) continue;
    const rowStr = (row as string[]).join(' ');
    const joMatch = rowStr.match(/W\d{4,5}/);
    const soMatch = rowStr.match(/S\d{4,6}/);
    if (joMatch) { destination = joMatch[0]; destinationType = 'JO'; }
    else if (soMatch) { destination = soMatch[0]; destinationType = 'SO'; }
    else if (rowStr.includes('GENERAL INVENTORY') || rowStr.includes('MRP')) {
      destination = 'INV'; destinationType = 'INV';
    }
  }

  // Parse data rows after header
  // Header: VENDOR, WASSON/VENDOR PART NUMBER, REV, DESCRIPTION, WASSON QTY, VENDOR QTY, VENDOR COST
  for (let i = headerRow + 1; i < data.length; i++) {
    const row = data[i] as unknown[];
    if (!row) continue;

    const partNumber = String(row[1] || '').trim();
    if (!partNumber) continue;

    const qty = toNum(row[4]);
    if (qty <= 0) continue;

    lines.push({
      format: 'requisition_form',
      sheetName: wb.SheetNames[0],
      rowNumber: i,
      partNumber,
      partRev: String(row[2] || '').trim(),
      description: String(row[3] || '').trim(),
      qty,
      vendor: String(row[0] || '').trim(),
      vendorPart: '',
      vendorQty: toNum(row[5]),
      unitCost: toNum(row[6]),
      destination,
      destinationType,
    });
  }

  return lines;
}

export function classifyDestination(dest: string): 'JO' | 'SO' | 'INV' | 'UNKNOWN' {
  if (!dest) return 'UNKNOWN';
  if (/^W\d{4,5}/.test(dest)) return 'JO';
  if (/^S\d{4,6}/.test(dest)) return 'SO';
  if (dest === 'INV' || dest.includes('INV') || dest.includes('STOCK')) return 'INV';
  return 'UNKNOWN';
}

function toNum(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = parseFloat(val.replace(/[,$]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  return 0;
}
