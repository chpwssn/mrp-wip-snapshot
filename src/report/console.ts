import type { JoSummary, BomLineAnalysis } from '../analysis/types.js';
import { BomLineStatus } from '../analysis/types.js';
import { shortJobNo } from '../analysis/types.js';

export function printConsoleReport(summaries: JoSummary[], snapshotId: number) {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const totalBomLines = summaries.reduce((s, j) => s + j.totalBomLines, 0);
  const totalBlindSpots = summaries.reduce((s, j) => s + j.blindSpotCount, 0);
  const totalRequisitioned = summaries.reduce((s, j) => s + j.requisitionedCount, 0);
  const totalPartial = summaries.reduce((s, j) => s + j.partialCount, 0);
  const totalPhantom = summaries.reduce((s, j) => s + j.phantomCount, 0);
  const totalStockAvailable = summaries.reduce((s, j) => s + j.stockAvailableCount, 0);

  // Sort: blind spots DESC, then partial DESC, then ship date ASC
  const sorted = [...summaries].sort((a, b) => {
    if (b.blindSpotCount !== a.blindSpotCount) return b.blindSpotCount - a.blindSpotCount;
    if (b.partialCount !== a.partialCount) return b.partialCount - a.partialCount;
    const dateA = a.notionPromisedShipDate || a.fddue_date || '9999';
    const dateB = b.notionPromisedShipDate || b.fddue_date || '9999';
    return dateA.localeCompare(dateB);
  });

  // Header
  console.log('');
  console.log('='.repeat(72));
  console.log(
    `WIP SHORTAGE SNAPSHOT  |  ${now}  |  Snapshot #${snapshotId}`,
  );
  console.log('='.repeat(72));
  console.log(
    `${summaries.length} W Job Orders  |  ${totalBomLines} BOM lines  |  ` +
    `${totalBlindSpots} Blind Spots  |  ${totalStockAvailable} Stock Available  |  ${totalPhantom} Phantom  |  ${totalPartial} Partial`,
  );
  console.log('');

  // Section: BLIND SPOTS
  const blindSpotJos = sorted.filter(s => s.blindSpotCount > 0);
  if (blindSpotJos.length > 0) {
    console.log('--- BLIND SPOTS (no plan for these parts) ---');
    console.log('');
    for (const jo of blindSpotJos) {
      printJoHeader(jo);
      const blindLines = jo.bomLines.filter(l => l.status === BomLineStatus.BLIND_SPOT);
      for (const line of blindLines) {
        printBomLine(line);
      }
      console.log('');
    }
  }

  // Section: REQUISITIONED (were blind spots, Jira req found)
  const reqJos = sorted.filter(s => s.requisitionedCount > 0 && s.blindSpotCount === 0);
  if (reqJos.length > 0) {
    console.log('--- REQUISITIONED (blind spots with Jira req found) ---');
    console.log('');
    for (const jo of reqJos) {
      printJoHeader(jo);
      const reqLines = jo.bomLines.filter(l => l.status === BomLineStatus.REQUISITIONED);
      for (const line of reqLines) {
        printBomLine(line, jo.jiraReqKeys);
      }
      console.log('');
    }
  }

  // Section: PARTIAL (POs exist but insufficient)
  const partialJos = sorted.filter(s => s.partialCount > 0 && s.blindSpotCount === 0 && s.requisitionedCount === 0);
  if (partialJos.length > 0) {
    console.log('--- PARTIAL (POs exist but don\'t cover full gap) ---');
    console.log('');
    for (const jo of partialJos) {
      printJoHeader(jo);
      const partialLines = jo.bomLines.filter(l => l.status === BomLineStatus.PARTIAL);
      for (const line of partialLines) {
        printBomLine(line);
      }
      console.log('');
    }
  }

  // Section: ON ORDER (all covered)
  const onOrderJos = sorted.filter(
    s => s.onOrderCount > 0 && s.blindSpotCount === 0 && s.requisitionedCount === 0 && s.partialCount === 0,
  );
  if (onOrderJos.length > 0) {
    console.log('--- ON ORDER (POs exist, not yet received) ---');
    console.log('');
    for (const jo of onOrderJos) {
      const shortJo = shortJobNo(jo.fjobno);
      const shipDate = jo.notionPromisedShipDate || jo.fddue_date || 'N/A';
      const notionStatus = jo.notionStatus ? ` | Notion: ${jo.notionStatus}` : '';
      console.log(
        `  ${shortJo}  (Due: ${fmtDate(shipDate)}${notionStatus})  ` +
        `${jo.onOrderCount} on order, ${jo.completeCount} complete`,
      );
    }
    console.log('');
  }

  // Section: STOCK AVAILABLE (kitting issue, not supply issue)
  const stockJos = sorted.filter(
    s => s.stockAvailableCount > 0 && s.blindSpotCount === 0 && s.requisitionedCount === 0 && s.partialCount === 0,
  );
  if (stockJos.length > 0) {
    console.log(`--- STOCK AVAILABLE (${totalStockAvailable} lines — inventory exists, needs kitting) ---`);
    console.log('');
    for (const jo of stockJos) {
      const shortJo = shortJobNo(jo.fjobno);
      const shipDate = jo.notionPromisedShipDate || jo.fddue_date || 'N/A';
      console.log(
        `  ${shortJo}  (Due: ${fmtDate(shipDate)})  ` +
        `${jo.stockAvailableCount} stock avail, ${jo.completeCount} complete`,
      );
    }
    console.log('');
  }

  // Section: COMPLETE (no action needed — blind spots, partials, and on-order all zero)
  const completeJos = sorted.filter(
    s => s.blindSpotCount === 0 && s.requisitionedCount === 0 && s.partialCount === 0 && s.onOrderCount === 0 && s.stockAvailableCount === 0,
  );
  if (completeJos.length > 0) {
    console.log(`--- ALL COMPLETE (${completeJos.length} JOs) ---`);
    console.log('');
    for (const jo of completeJos) {
      const shortJo = shortJobNo(jo.fjobno);
      console.log(`  ${shortJo}  (${jo.completeCount}/${jo.totalBomLines} complete)`);
    }
    console.log('');
  }
}

function printJoHeader(jo: JoSummary) {
  const shortJo = shortJobNo(jo.fjobno);
  const shipDate = jo.notionPromisedShipDate || jo.fddue_date || 'N/A';
  const priority = jo.notionPriority || jo.fpriority || '';
  const toolInfo = (jo as any).toolData as { company: string; systemDescription: string } | undefined;
  const customerDesc = toolInfo?.company || jo.fdescript || jo.fpartno;

  console.log(
    `${shortJo}  ${customerDesc}` +
    `  (Qty: ${jo.fquantity}, Due: ${fmtDate(shipDate)}${priority ? ', Priority: ' + priority : ''})`,
  );

  const parts: string[] = [];
  if (jo.notionStatus) parts.push(`Notion: ${jo.notionStatus}`);
  if (jo.notionBlocker) parts.push(`Blocker: "${jo.notionBlocker}"`);
  const tool = (jo as any).toolData as { statusPhase: string; kittingNotes: string; partsOrdered: string; lastPartDue: string; company: string; willShip: string } | undefined;
  if (tool) {
    parts.push(`Tool: ${tool.statusPhase}`);
    if (tool.kittingNotes) parts.push(`Kit: "${tool.kittingNotes}"`);
    if (tool.lastPartDue) parts.push(`Last part: ${tool.lastPartDue}`);
  }
  if (parts.length > 0) console.log(`  ${parts.join(' | ')}`);

  const counts: string[] = [];
  if (jo.blindSpotCount > 0) counts.push(`${jo.blindSpotCount} blind spots`);
  if (jo.stockAvailableCount > 0) counts.push(`${jo.stockAvailableCount} stock avail`);
  if (jo.phantomCount > 0) counts.push(`${jo.phantomCount} phantom`);
  if (jo.requisitionedCount > 0) counts.push(`${jo.requisitionedCount} requisitioned`);
  if (jo.partialCount > 0) counts.push(`${jo.partialCount} partial`);
  if (jo.onOrderCount > 0) counts.push(`${jo.onOrderCount} on order`);
  counts.push(`${jo.completeCount} complete`);
  if (jo.makeBlockedCount > 0) counts.push(`${jo.makeBlockedCount} assy BLOCKED`);
  if (jo.makeNoJoCount > 0) counts.push(`${jo.makeNoJoCount} assy NO IJO`);
  if (jo.makeInProgressCount > 0) counts.push(`${jo.makeInProgressCount} assy in-prog`);
  if (jo.makeCompleteCount > 0) counts.push(`${jo.makeCompleteCount} assy done`);
  if (jo.makeCount > 0) counts.push(`${jo.makeCount} make`);
  console.log(`  ${counts.join(', ')}`);

  if (jo.jiraReqKeys.length > 0) {
    console.log(`  Jira: ${jo.jiraReqKeys.join(', ')}`);
  }
}

function printBomLine(line: BomLineAnalysis, jiraKeys?: string[]) {
  const part = line.fbompart.padEnd(14);
  const desc = (line.fbomdesc || '').slice(0, 24).padEnd(24);
  const need = `need ${line.extendedQty}`;
  const have = `have ${line.totalSupplied}`;
  const gapStr = `gap ${line.gap}`;

  let suffix = '';
  if (line.poNumbers.length > 0) {
    suffix += `  [PO: ${line.poNumbers.join(',')}]`;
  }
  if (jiraKeys?.length) {
    suffix += `  [${jiraKeys.join(', ')}]`;
  }

  console.log(`    ${part}  ${desc}  ${need}, ${have}, ${gapStr}${suffix}`);

  // Context line: on-hand (inline from inmastx) + system POs (from enrichment)
  const context: string[] = [];

  // On-hand from inline inmastx data
  if (line.onHandQty > 0) {
    context.push(`ON HAND: ${line.onHandQty}`);
  }

  // System-wide POs (if enriched via Redbook-style queries)
  const sys = (line as any).systemPo as { totalOpen: number; overdueQty: number; details: Array<{ fpono: string; openQty: number; fvendno: string; isOverdue: boolean; daysPastDue: number | null; fjokey: string; fcategory: string }> } | undefined;
  if (sys && sys.totalOpen > 0) {
    const overdueNote = sys.overdueQty > 0
      ? ` (${sys.overdueQty} OVERDUE)`
      : '';
    const destinations = sys.details
      .slice(0, 3)
      .map(d => {
        const dest = d.fjokey || (d.fcategory === 'SO' ? 'SO' : 'INV');
        const overdue = d.isOverdue ? ` OVERDUE ${d.daysPastDue}d` : '';
        return `${d.fpono}→${dest} ${d.openQty}${overdue}`;
      })
      .join(', ');
    context.push(`SYS PO: ${sys.totalOpen} open${overdueNote} [${destinations}]`);
  }

  if (context.length > 0) {
    console.log(`      ↳ ${context.join('  |  ')}`);
  }
}

function fmtDate(d: string | null): string {
  if (!d) return 'N/A';
  // Handle ISO dates — show just the date part
  return d.slice(0, 10);
}
