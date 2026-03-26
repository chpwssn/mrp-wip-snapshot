import type Database from 'better-sqlite3';
import XLSX from 'xlsx';
import { readFileSync, existsSync } from 'fs';
import type { JoSummary } from '../analysis/types.js';
import { shortJobNo } from '../analysis/types.js';
import { logger } from '../utils/logger.js';
import type { Config } from '../utils/config.js';

interface ToolRow {
  fjobno: string;
  company: string;
  country: string;
  soNumber: string;
  poNumber: string;
  systemDescription: string;
  statusRaw: string;
  statusPhase: string;
  kittingNotes: string;
  buildStart: string;
  buildFinish: string;
  labStart: string;
  labFinish: string;
  install: string;
  poRecDate: string;
  poConfirmedDate: string;
  orderEntryDate: string;
  willShip: string;
  quotedDelivery: string;
  partsOrdered: string;
  lastPartDue: string;
  gcStatus: string;
  standardsStatus: string;
  softwareStatus: string;
  computerStatus: string;
  specialHwStatus: string;
  totalPoValue: number;
  notes: string;
}

export function collectToolTracking(db: Database.Database, config: Config): Map<string, ToolRow> {
  const toolPath = config.toolPath;
  if (!existsSync(toolPath)) {
    logger.warn(`The Tool spreadsheet not found at ${toolPath} — skipping`);
    return new Map();
  }

  logger.info(`Reading The Tool (${toolPath})...`);
  const buf = readFileSync(toolPath);
  const wb = XLSX.read(buf, { type: 'buffer' });

  const sheet = wb.Sheets['Order Tracking'];
  if (!sheet) {
    logger.warn('Order Tracking sheet not found in The Tool');
    return new Map();
  }

  const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
  const rows = new Map<string, ToolRow>();

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO tool_tracking (
      fjobno, company, country, so_number, po_number, system_description,
      status_raw, status_phase, kitting_notes,
      build_start, build_finish, lab_start, lab_finish,
      install, po_rec_date, po_confirmed_date, order_entry_date,
      will_ship, quoted_delivery, parts_ordered, last_part_due,
      gc_status, standards_status, software_status, computer_status,
      special_hw_status, total_po_value, notes, synced_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, datetime('now')
    )
  `);

  const insertAll = db.transaction(() => {
    for (let i = 3; i < data.length; i++) {
      const row = data[i] as unknown[];
      if (!row || !row[2]) continue;

      const wo = str(row[2]).trim();
      if (!wo.startsWith('W')) continue;

      const statusRaw = str(row[6]);
      const parsed: ToolRow = {
        fjobno: wo,
        company: str(row[0]),
        country: str(row[1]),
        soNumber: extractSo(str(row[3])),
        poNumber: str(row[4]),
        systemDescription: str(row[5]),
        statusRaw,
        statusPhase: parsePhase(statusRaw),
        kittingNotes: str(row[7]),
        buildStart: excelDate(row[8]),
        buildFinish: excelDate(row[9]),
        labStart: excelDate(row[10]),
        labFinish: excelDate(row[11]),
        install: str(row[12]),
        poRecDate: excelDate(row[14]),
        poConfirmedDate: excelDate(row[15]),
        orderEntryDate: excelDate(row[16]),
        willShip: str(row[17]),
        quotedDelivery: excelDate(row[18]),
        partsOrdered: str(row[33]),
        lastPartDue: str(row[34]),
        gcStatus: str(row[23]),
        standardsStatus: str(row[26]),
        softwareStatus: str(row[29]),
        computerStatus: str(row[32]),
        specialHwStatus: str(row[37]),
        totalPoValue: num(row[38]),
        notes: str(row[41]),
      };

      rows.set(wo, parsed);

      upsert.run(
        parsed.fjobno, parsed.company, parsed.country, parsed.soNumber,
        parsed.poNumber, parsed.systemDescription, parsed.statusRaw,
        parsed.statusPhase, parsed.kittingNotes, parsed.buildStart,
        parsed.buildFinish, parsed.labStart, parsed.labFinish,
        parsed.install, parsed.poRecDate, parsed.poConfirmedDate,
        parsed.orderEntryDate, parsed.willShip, parsed.quotedDelivery,
        parsed.partsOrdered, parsed.lastPartDue, parsed.gcStatus,
        parsed.standardsStatus, parsed.softwareStatus, parsed.computerStatus,
        parsed.specialHwStatus, parsed.totalPoValue, parsed.notes,
      );
    }
  });

  insertAll();
  logger.info(`The Tool: ${rows.size} active work orders loaded`);
  return rows;
}

export function enrichWithToolTracking(
  db: Database.Database,
  snapshotId: number,
  summaries: JoSummary[],
  toolData: Map<string, ToolRow>,
): void {
  if (toolData.size === 0) return;

  // Add tool_* columns to jo_summary if needed (we'll store as JSON for now)
  const updateStmt = db.prepare(`
    UPDATE jo_summary SET
      notion_blocker = COALESCE(notion_blocker, '') || CASE WHEN ? != '' THEN ' [Tool: ' || ? || ']' ELSE '' END
    WHERE snapshot_id = ? AND fjobno = ?
  `);

  let matched = 0;
  for (const summary of summaries) {
    const shortJo = shortJobNo(summary.fjobno);
    const tool = toolData.get(shortJo);
    if (!tool) continue;

    matched++;
    // Attach to in-memory summary for reporting
    (summary as any).toolData = tool;
  }

  logger.info(`The Tool enrichment: ${matched}/${summaries.length} JOs matched`);
}

function parsePhase(status: string): string {
  const sl = status.toLowerCase();
  if (sl.includes('ship') || sl.includes('packaging')) return 'Pre-Ship';
  if (sl.includes('signoff') || sl.includes('sign off')) return 'Final QC';
  if (sl.includes('fat')) return 'FAT';
  if (sl.includes('lab') || sl.includes('qc') || sl.includes('repeatability')) return 'Lab/QC';
  if (sl.includes('floor') || sl.includes('build')) return 'Build';
  if (sl.includes('engineering') || sl.includes('eng.')) return 'Engineering';
  if (sl.includes('planning') || sl.includes('plan')) return 'Planning';
  if (sl.includes('hold') || sl.includes('bounc')) return 'Hold/Rework';
  if (sl.includes('parts hold')) return 'Parts Hold';
  return 'Unknown';
}

function extractSo(raw: string): string {
  const match = raw.match(/S\d{5}/);
  return match ? match[0] : '';
}

function str(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function num(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val.replace(/[,$]/g, '')) || 0;
  return 0;
}

function excelDate(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'number') {
    // Excel serial date → JS date
    const d = new Date((val - 25569) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return String(val).trim();
}
