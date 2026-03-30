import type Database from 'better-sqlite3';
import { GraphQLClient } from '../graphql/client.js';
import { GET_PO_ITEMS_FOR_PART } from '../graphql/queries.js';
import type { GqlPoItemsForPartResponse } from '../graphql/types.js';
import type { JoSummary } from '../analysis/types.js';
import { BomLineStatus } from '../analysis/types.js';
import { logger } from '../utils/logger.js';
import type { Config } from '../utils/config.js';

interface SystemPoSummary {
  totalOpen: number;
  totalOrdered: number;
  totalReceived: number;
  overdueQty: number;
  details: SystemPoDetail[];
}

interface SystemPoDetail {
  fpono: string;
  fvendno: string;
  poStatus: string;
  fordqty: number;
  frcpqty: number;
  openQty: number;
  freqdate: string | null;
  flstpdate: string | null;
  fjokey: string;
  fcategory: string;
  isOverdue: boolean;
  daysPastDue: number | null;
}

/**
 * For blind spot and partial parts, check if there are open POs anywhere in the system.
 * On-hand and phantom classification are already handled inline via inmastx on the JODBOM query.
 */
export async function enrichBlindSpotsWithSystemData(
  config: Config,
  db: Database.Database,
  snapshotId: number,
  summaries: JoSummary[],
): Promise<void> {
  const client = new GraphQLClient(config.m2mGraphqlUrl);

  // Collect unique part numbers from blind spots and partials
  const partsToCheck = new Set<string>();
  for (const jo of summaries) {
    for (const line of jo.bomLines) {
      if (line.status === BomLineStatus.BLIND_SPOT || line.status === BomLineStatus.PARTIAL) {
        if (line.fbompart) partsToCheck.add(line.fbompart);
      }
    }
  }

  if (partsToCheck.size === 0) {
    logger.info('No blind spot/partial parts to check for system-wide POs');
    return;
  }

  logger.info(`Checking ${partsToCheck.size} blind-spot/partial parts for system-wide POs (Redbook-style)`);

  // Batch-fetch PO data for each part
  const poCache = new Map<string, SystemPoSummary>();
  const parts = [...partsToCheck];
  const batchSize = config.concurrency;

  for (let i = 0; i < parts.length; i += batchSize) {
    const batch = parts.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map(async partno => {
        const poData = await fetchSystemPos(client, partno);
        return { partno, poData };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        poCache.set(result.value.partno, result.value.poData);
      } else {
        logger.warn(`Failed to fetch system POs for part:`, result.reason);
      }
    }

    if (i + batchSize < parts.length) {
      await sleep(config.batchDelayMs);
    }

    logger.debug(`System PO check: ${Math.min(i + batchSize, parts.length)}/${parts.length} parts`);
  }

  // Update SQLite with system PO data
  const updateStmt = db.prepare(`
    UPDATE bom_line_status SET
      sys_po_total_open = ?,
      sys_po_total_ordered = ?,
      sys_po_total_received = ?,
      sys_po_overdue_qty = ?,
      sys_po_details_json = ?
    WHERE snapshot_id = ? AND fbompart = ? AND status IN ('BLIND_SPOT', 'PARTIAL', 'REQUISITIONED')
  `);

  const update = db.transaction(() => {
    for (const [partno, poSummary] of poCache) {
      updateStmt.run(
        poSummary.totalOpen,
        poSummary.totalOrdered,
        poSummary.totalReceived,
        poSummary.overdueQty,
        JSON.stringify(poSummary.details),
        snapshotId,
        partno,
      );
    }
  });

  update();

  // Reclassify blind spots that have system POs and update in-memory summaries
  const reclassifyStmt = db.prepare(`
    UPDATE bom_line_status SET status = ?
    WHERE snapshot_id = ? AND fjobno = ? AND fbominum = ?
  `);
  const updateJoCounts = db.prepare(`
    UPDATE jo_summary SET blind_spot_count = ?, on_order_count = ?, partial_count = ?
    WHERE snapshot_id = ? AND fjobno = ?
  `);

  const reclassify = db.transaction(() => {
    for (const jo of summaries) {
      for (const line of jo.bomLines) {
        if (line.status !== BomLineStatus.BLIND_SPOT && line.status !== BomLineStatus.PARTIAL) continue;
        const po = poCache.get(line.fbompart);
        if (po) (line as any).systemPo = po;

        // Reclassify BLIND_SPOT lines that have open system POs
        if (line.status === BomLineStatus.BLIND_SPOT && po && po.totalOpen > 0) {
          const newStatus = po.totalOpen >= line.gap
            ? BomLineStatus.ON_ORDER
            : BomLineStatus.PARTIAL;
          line.status = newStatus;
          reclassifyStmt.run(newStatus, snapshotId, line.fjobno, line.fbominum);
        }
      }

      // Recompute JO-level counts after reclassification
      let blindSpotCount = 0;
      let onOrderCount = 0;
      let partialCount = 0;
      for (const line of jo.bomLines) {
        if (line.status === BomLineStatus.BLIND_SPOT) blindSpotCount++;
        else if (line.status === BomLineStatus.ON_ORDER) onOrderCount++;
        else if (line.status === BomLineStatus.PARTIAL) partialCount++;
      }
      jo.blindSpotCount = blindSpotCount;
      jo.onOrderCount = onOrderCount;
      jo.partialCount = partialCount;
      updateJoCounts.run(blindSpotCount, onOrderCount, partialCount, snapshotId, jo.fjobno);
    }
  });

  reclassify();

  // Log summary
  let partsWithSystemPos = 0;
  let partsWithOverduePos = 0;
  for (const [, po] of poCache) {
    if (po.totalOpen > 0) partsWithSystemPos++;
    if (po.overdueQty > 0) partsWithOverduePos++;
  }

  logger.info(
    `System PO enrichment: ${partsWithSystemPos}/${partsToCheck.size} parts have open POs elsewhere, ` +
    `${partsWithOverduePos} have overdue POs`,
  );
}

async function fetchSystemPos(
  client: GraphQLClient,
  partno: string,
): Promise<SystemPoSummary> {
  const data = await client.query<GqlPoItemsForPartResponse>(GET_PO_ITEMS_FOR_PART, {
    partno,
  });

  const items = data.getPOItemsWhere ?? [];
  const today = new Date().toISOString().slice(0, 10);

  // Only consider open POs (M2M pads status: "OPEN                ")
  const openItems = items.filter(po => {
    const status = po.pomast?.fstatus?.trim().toUpperCase() || '';
    return status === 'OPEN' && (po.fordqty || 0) > (po.frcpqty || 0);
  });

  const details: SystemPoDetail[] = openItems.map(po => {
    const openQty = Math.max(0, (po.fordqty || 0) - (po.frcpqty || 0));
    // M2M uses 1900-01-01 as null date — ignore it
    const rawReq = po.freqdate?.slice(0, 10) || null;
    const rawPromise = po.flstpdate?.slice(0, 10) || null;
    const isNullDate = (d: string | null) => !d || d <= '1901-01-01';
    const dueDate = !isNullDate(rawReq) ? rawReq : !isNullDate(rawPromise) ? rawPromise : null;
    const isOverdue = dueDate ? dueDate < today : false;
    const daysPastDue = isOverdue && dueDate
      ? Math.floor((Date.now() - new Date(dueDate).getTime()) / 86400000)
      : null;

    return {
      fpono: po.fpono?.trim() || '',
      fvendno: po.pomast?.fvendno?.trim() || '',
      poStatus: po.pomast?.fstatus?.trim() || '',
      fordqty: po.fordqty || 0,
      frcpqty: po.frcpqty || 0,
      openQty,
      freqdate: po.freqdate,
      flstpdate: po.flstpdate,
      fjokey: po.fjokey?.trim() || '',
      fcategory: po.fcategory?.trim() || '',
      isOverdue,
      daysPastDue,
    };
  });

  return {
    totalOpen: details.reduce((s, d) => s + d.openQty, 0),
    totalOrdered: items.reduce((s, po) => s + (po.fordqty || 0), 0),
    totalReceived: items.reduce((s, po) => s + (po.frcpqty || 0), 0),
    overdueQty: details.filter(d => d.isOverdue).reduce((s, d) => s + d.openQty, 0),
    details,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
