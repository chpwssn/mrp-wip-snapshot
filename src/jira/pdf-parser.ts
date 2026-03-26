import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { logger } from '../utils/logger.js';
import type { ParsedReqLine } from './xlsx-parser.js';
import { classifyDestination } from './xlsx-parser.js';

interface PdfFormField {
  name: string;
  value: string;
  type: string;
}

/**
 * Parse a PDF requisition and extract line items.
 * Handles two formats:
 * 1. Fillable req form (Word template with form fields)
 * 2. Column call-out sheet (text-based table)
 */
export async function parsePdf(
  buffer: Buffer,
  filename: string,
  issueKey: string,
): Promise<ParsedReqLine[]> {
  try {
    const uint8 = new Uint8Array(buffer);
    const doc = await getDocument({ data: uint8 }).promise;

    // Try form fields first (fillable req forms)
    const fields = await extractFormFields(doc);
    if (fields.length > 0) {
      const fieldNames = fields.map(f => f.name);
      // Detect MRP Requisition Order Form (has "M2M VENDOR NO" and "INV OR WO" fields)
      if (fieldNames.some(n => n.startsWith('M2M VENDOR NO') || n.startsWith('INV OR WO'))) {
        return parseMrpReqFormFields(fields, filename);
      }
      // Employee Requisition Order Form
      return parseReqFormFields(fields, filename);
    }

    // Fall back to text extraction (column call-outs, MRP req PDFs)
    const text = await extractText(doc);
    return parseFromText(text, filename);
  } catch (err) {
    logger.warn(`Failed to parse PDF ${filename} (${issueKey}): ${err}`);
    return [];
  }
}

async function extractFormFields(doc: any): Promise<PdfFormField[]> {
  const fields: PdfFormField[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const annotations = await page.getAnnotations();
    for (const ann of annotations) {
      if (ann.fieldType || ann.fieldName) {
        const val = ann.fieldValue ?? ann.buttonValue ?? '';
        if (val && val !== 'Off') {
          fields.push({
            name: ann.fieldName || '',
            value: String(val).trim(),
            type: ann.fieldType || ann.subtype || '',
          });
        }
      }
    }
  }
  return fields;
}

async function extractText(doc: any): Promise<string> {
  const lines: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item: any) => item.str).join(' ');
    lines.push(pageText);
  }
  return lines.join('\n');
}

function parseReqFormFields(fields: PdfFormField[], filename: string): ParsedReqLine[] {
  const fieldMap = new Map<string, string>();
  for (const f of fields) {
    fieldMap.set(f.name, f.value);
  }

  // Determine destination
  let destination = '';
  let destinationType: 'JO' | 'SO' | 'INV' | 'UNKNOWN' = 'UNKNOWN';

  const woCheckbox = fieldMap.get('WO checkbox');
  const invCheckbox = fieldMap.get('inventory check box');
  const woNumber = fieldMap.get('PROJECT  WORK ORDER') || fieldMap.get('PROJECT / WORK ORDER') || '';
  const submitter = (fieldMap.get('NAME') || '').toLowerCase();

  // Check for SO number in WARRANTY/SO# field area — multiple fields may contain it
  const soCandidate = fieldMap.get('CUSTOMER') || fieldMap.get('IT I0484') || '';
  const soFromWarrantyField = (() => {
    // Look through all field values for an S##### pattern near the warranty/SO section
    for (const [name, val] of fieldMap) {
      if (/^S\d{4,6}/.test(val.trim())) return val.trim();
    }
    return '';
  })();

  // Priority: SO number takes precedence if present (regardless of which checkbox is ticked)
  // Alan Barkley checks "Warranty" but means SO — and generally if an SO# is filled in, it's an SO order
  if (soFromWarrantyField) {
    destination = soFromWarrantyField;
    destinationType = 'SO';
  } else if (woCheckbox === 'Yes' && woNumber) {
    destination = woNumber;
    destinationType = 'JO';
  } else if (invCheckbox === 'Yes') {
    destination = 'INV';
    destinationType = 'INV';
  }

  // Also try to find JO/SO from filename
  if (!destination) {
    const joMatch = filename.match(/W\d{4,5}/);
    const soMatch = filename.match(/S\d{4,6}/);
    if (joMatch) { destination = joMatch[0]; destinationType = 'JO'; }
    else if (soMatch) { destination = soMatch[0]; destinationType = 'SO'; }
  }

  // Extract line items (up to 15 rows in the form)
  const lines: ParsedReqLine[] = [];
  for (let row = 1; row <= 15; row++) {
    const suffix = row === 1 ? 'Row1' : `Row${row}`;
    const partNumber = (
      fieldMap.get(`WASSON VENDOR PART NUMBER${suffix}`) ||
      fieldMap.get(`WASSON VENDOR PART NUMBER${suffix === 'Row1' ? 'Row1' : suffix}`) ||
      ''
    ).trim();

    if (!partNumber) continue;

    const qty = parseFloat(fieldMap.get(`WASSON QTY${suffix}`) || '0') || 0;
    if (qty <= 0) continue;

    lines.push({
      format: 'req_form_pdf',
      sheetName: 'page1',
      rowNumber: row,
      partNumber,
      partRev: (fieldMap.get(`REV This field is required${suffix}`) || '').trim(),
      description: (fieldMap.get(`DESCRIPTION${suffix}`) || '').trim(),
      qty,
      vendor: (fieldMap.get(`VENDOR If specific vendor is required${suffix}`) || '').trim(),
      vendorPart: '',
      vendorQty: parseFloat(fieldMap.get(`VENDOR QTY${suffix}`) || '0') || 0,
      unitCost: parseFloat((fieldMap.get(`COST PER UNIT${suffix}`) || '0').replace(/[^0-9.]/g, '')) || 0,
      destination,
      destinationType,
    });
  }

  return lines;
}

function parseMrpReqFormFields(fields: PdfFormField[], filename: string): ParsedReqLine[] {
  const fieldMap = new Map<string, string>();
  for (const f of fields) {
    fieldMap.set(f.name, f.value);
  }

  const lines: ParsedReqLine[] = [];

  // MRP form has per-row fields: M2M VENDOR NORow1, WASSON PART  WSNRow1, REVRow1,
  // DESCRIPTIONRow1, UM QTY FOR INV REQUIREDRow1, INV OR WORow1, COST UNITRow1
  for (let row = 1; row <= 20; row++) {
    const suffix = `Row${row}`;
    const partNumber = (fieldMap.get(`WASSON PART  WSN${suffix}`) || '').trim();
    if (!partNumber) continue;

    const qtyStr = (fieldMap.get(`UM QTY FOR INV REQUIRED${suffix}`) || '').replace(/[^0-9.]/g, '');
    const qty = parseFloat(qtyStr) || 0;
    if (qty <= 0) continue;

    const dest = (fieldMap.get(`INV OR WO${suffix}`) || '').trim();

    lines.push({
      format: 'mrp_req_form_pdf',
      sheetName: 'page1',
      rowNumber: row,
      partNumber,
      partRev: (fieldMap.get(`REV${suffix}`) || '').trim(),
      description: (fieldMap.get(`DESCRIPTION${suffix}`) || '').trim(),
      qty,
      vendor: (fieldMap.get(`M2M VENDOR NO${suffix}`) || '').trim(),
      vendorPart: '',
      vendorQty: parseFloat((fieldMap.get(`UM QTY FOR VENDOR IF DIFFERS FROM INV UM${suffix}`) || '').replace(/[^0-9.]/g, '')) || 0,
      unitCost: parseFloat((fieldMap.get(`COST UNIT${suffix}`) || '0').replace(/[^0-9.]/g, '')) || 0,
      destination: classifyMrpDestination(dest),
      destinationType: classifyDestination(classifyMrpDestination(dest)),
    });
  }

  return lines;
}

/** Normalize MRP req form destinations like "I4698 ORDER TO INV" → "INV", "W9663" → "W9663" */
function classifyMrpDestination(dest: string): string {
  if (!dest) return '';
  // "INV" or contains "INV"
  if (/^INV$/i.test(dest) || /ORDER TO INV/i.test(dest)) return 'INV';
  // JO number
  const joMatch = dest.match(/W\d{4,5}/);
  if (joMatch) return joMatch[0];
  // I-number (internal order) → treat as INV
  if (/^I\d{3,5}/.test(dest)) return 'INV';
  return dest;
}

function parseFromText(text: string, filename: string): ParsedReqLine[] {
  const lines: ParsedReqLine[] = [];

  // Try to detect column call-out format
  // "WORK ORDER:___ W9704" + table with VPN, WASSON PN, DESCRIPTION, QTY
  const woMatch = text.match(/WORK ORDER[:\s_]+([WI]\d{4,5})/i);
  const joNumber = woMatch?.[1] || '';

  // Look for part number patterns in the text
  // Column call-out: "CP7586   CP-Al2O3/Na2SO4, 25 m...   1"
  const partPattern = /([A-Z]{2}\d{4,5}(?:-\d{2,3})?)\s+(.+?)\s+(\d+)\s/g;
  let match;
  let rowNum = 0;

  while ((match = partPattern.exec(text)) !== null) {
    rowNum++;
    const partNumber = match[1].trim();
    const description = match[2].trim();
    const qty = parseInt(match[3], 10);

    if (qty > 0 && partNumber) {
      lines.push({
        format: 'column_callout_pdf',
        sheetName: 'page1',
        rowNumber: rowNum,
        partNumber,
        partRev: '',
        description,
        qty,
        vendor: '',
        vendorPart: '',
        vendorQty: 0,
        unitCost: 0,
        destination: joNumber || (filename.match(/W\d{4,5}/)?.[0] || ''),
        destinationType: joNumber ? 'JO' : 'UNKNOWN',
      });
    }
  }

  // Also try Wasson part number patterns (5-digit-dash-3-digit)
  if (lines.length === 0) {
    const wassonPattern = /(\d{4,5}-\d{2,3})\s+(.+?)\s+(\d+)\s/g;
    while ((match = wassonPattern.exec(text)) !== null) {
      rowNum++;
      lines.push({
        format: 'text_pdf',
        sheetName: 'page1',
        rowNumber: rowNum,
        partNumber: match[1].trim(),
        partRev: '',
        description: match[2].trim(),
        qty: parseInt(match[3], 10),
        vendor: '',
        vendorPart: '',
        vendorQty: 0,
        unitCost: 0,
        destination: joNumber || (filename.match(/W\d{4,5}/)?.[0] || ''),
        destinationType: joNumber ? 'JO' : 'UNKNOWN',
      });
    }
  }

  return lines;
}
