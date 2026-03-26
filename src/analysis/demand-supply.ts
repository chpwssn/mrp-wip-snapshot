import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

export interface DemandSupplyGap {
  partNumber: string;
  description: string;
  joCount: number;
  totalDemand: number;
  totalIssued: number;
  openNeed: number;
  directPoOnOrder: number;
  systemPoOpen: number;
  onHand: number;
  totalSupply: number;
  shortfall: number;
  jobNumbers: string[];
}

export function analyzeDemandSupplyGaps(
  db: Database.Database,
  snapshotId: number,
): DemandSupplyGap[] {
  logger.info('Analyzing system-wide demand vs supply...');

  const rows = db.prepare(`
    WITH demand AS (
      SELECT
        fbompart,
        MAX(fbomdesc) as description,
        SUM(extended_qty) as total_demand,
        SUM(fqty_iss) as total_issued,
        SUM(po_received_qty) as total_po_received,
        SUM(po_still_on_order) as total_direct_on_order,
        SUM(CASE WHEN extended_qty - fqty_iss - po_received_qty > 0
            THEN extended_qty - fqty_iss - po_received_qty ELSE 0 END) as total_open_need,
        MAX(COALESCE(sys_po_total_open, 0)) as sys_po_open,
        MAX(COALESCE(on_hand_qty, 0)) as on_hand,
        COUNT(DISTINCT fjobno) as jo_count,
        GROUP_CONCAT(DISTINCT REPLACE(fjobno, '-0000', '')) as job_numbers
      FROM bom_line_status
      WHERE snapshot_id = ?
        AND status NOT IN (
          'PHANTOM', 'MAKE', 'MAKE_COMPLETE', 'MAKE_IN_PROGRESS',
          'MAKE_BLOCKED', 'MAKE_NO_JO', 'COMPLETE', 'OVERISSUED'
        )
      GROUP BY fbompart
      HAVING total_open_need > 0
    )
    SELECT *,
      total_direct_on_order + COALESCE(sys_po_open, 0) + COALESCE(on_hand, 0) as total_supply,
      total_open_need - total_direct_on_order - COALESCE(sys_po_open, 0) - COALESCE(on_hand, 0) as shortfall
    FROM demand
    WHERE total_open_need - total_direct_on_order - COALESCE(sys_po_open, 0) - COALESCE(on_hand, 0) > 0
    ORDER BY shortfall DESC
  `).all(snapshotId) as any[];

  const gaps: DemandSupplyGap[] = rows.map(r => ({
    partNumber: r.fbompart,
    description: r.description || '',
    joCount: r.jo_count,
    totalDemand: r.total_demand,
    totalIssued: r.total_issued,
    openNeed: r.total_open_need,
    directPoOnOrder: r.total_direct_on_order,
    systemPoOpen: r.sys_po_open || 0,
    onHand: r.on_hand || 0,
    totalSupply: r.total_supply || 0,
    shortfall: r.shortfall,
    jobNumbers: (r.job_numbers || '').split(',').filter(Boolean),
  }));

  logger.info(`Demand-supply analysis: ${gaps.length} parts with shortfall (demand > all known supply)`);
  return gaps;
}
