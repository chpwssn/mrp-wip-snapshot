import type { JoSummary, BomLineAnalysis } from '../analysis/types.js';
import { BomLineStatus, shortJobNo } from '../analysis/types.js';
import type { DemandSupplyGap } from '../analysis/demand-supply.js';
import { readFileSync } from 'fs';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    return pkg.version || 'unknown';
  } catch { return 'unknown'; }
}

interface ToolData {
  company: string;
  systemDescription: string;
  statusPhase: string;
  statusRaw: string;
  kittingNotes: string;
  partsOrdered: string;
  lastPartDue: string;
  willShip: string;
  buildStart: string;
  buildFinish: string;
  quotedDelivery: string;
  orderEntryDate: string;
}

interface SystemPo {
  totalOpen: number;
  overdueQty: number;
  details: Array<{
    fpono: string;
    fvendno: string;
    openQty: number;
    isOverdue: boolean;
    daysPastDue: number | null;
    fjokey: string;
    fcategory: string;
  }>;
}

export function generateMarkdownReport(summaries: JoSummary[] & { __ijoSummaries?: JoSummary[] }, snapshotId: number, demandGaps?: DemandSupplyGap[]): string {
  const allIJos: JoSummary[] = (summaries as any).__ijoSummaries ?? [];
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const totalBomLines = summaries.reduce((s, j) => s + j.totalBomLines, 0);
  const totalBlindSpots = summaries.reduce((s, j) => s + j.blindSpotCount, 0);
  const totalRequisitioned = summaries.reduce((s, j) => s + j.requisitionedCount, 0);
  const totalStockAvail = summaries.reduce((s, j) => s + j.stockAvailableCount, 0);
  const totalPhantom = summaries.reduce((s, j) => s + j.phantomCount, 0);

  const sorted = [...summaries].sort((a, b) =>
    a.fjobno.localeCompare(b.fjobno),
  );

  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  w(`# WIP Shortage Snapshot`);
  w('');
  const version = getVersion();
  w(`**Date:** ${now} | **Snapshot:** #${snapshotId} | **Version:** ${version} | Help: [unitool.dev/wip-snapshot/help.html](https://unitool.dev/wip-snapshot/help.html)`);
  w('');
  w(`| Metric | Count |`);
  w(`|--------|-------|`);
  w(`| W Job Orders | ${summaries.length} |`);
  w(`| BOM Lines | ${totalBomLines} |`);
  w(`| Blind Spots | ${totalBlindSpots} |`);
  w(`| Stock Available | ${totalStockAvail} |`);
  w(`| Phantom | ${totalPhantom} |`);
  w(`| Requisitioned | ${totalRequisitioned} |`);
  w('');

  // System-wide demand vs supply
  if (demandGaps && demandGaps.length > 0) {
    w(`## System-Wide Shortfall (Demand > All Known Supply)`);
    w('');
    w(`${demandGaps.length} parts where open demand across all JOs exceeds POs + on-hand inventory.`);
    w('');
    w(`| Part | Description | JOs | Open Need | Direct PO | Sys PO | On Hand | **Shortfall** |`);
    w(`|------|-------------|:---:|----------:|----------:|-------:|--------:|--------------:|`);
    for (const gap of demandGaps) {
      const jos = gap.jobNumbers.length <= 3
        ? gap.jobNumbers.join(', ')
        : `${gap.jobNumbers.slice(0, 3).join(', ')}+${gap.jobNumbers.length - 3}`;
      w(`| ${gap.partNumber} | ${gap.description.slice(0, 30)} | ${gap.joCount} | ${gap.openNeed} | ${gap.directPoOnOrder} | ${gap.systemPoOpen} | ${gap.onHand} | **${gap.shortfall}** |`);
    }
    w('');
  }

  // Blind Spots
  const blindSpotJos = sorted.filter(s => s.blindSpotCount > 0 || s.makeBlockedCount > 0 || s.makeNoJoCount > 0);
  const blindSpotJoSet = new Set(blindSpotJos.map(j => j.fjobno));

  if (blindSpotJos.length > 0) {
    w(`## Blind Spots & Blocked Assemblies`);
    w('');
    for (const jo of blindSpotJos) {
      writeJoSection(jo, [BomLineStatus.BLIND_SPOT, BomLineStatus.MAKE_BLOCKED, BomLineStatus.MAKE_NO_JO], w);
    }
  }

  // Requisitioned (exclude JOs already in blind spots section)
  const reqJos = sorted.filter(s => s.requisitionedCount > 0 && !blindSpotJoSet.has(s.fjobno));
  if (reqJos.length > 0) {
    w(`## Requisitioned`);
    w('');
    for (const jo of reqJos) {
      writeJoSection(jo, [BomLineStatus.REQUISITIONED], w);
    }
  }

  // Stock Available (exclude JOs already shown in earlier sections)
  const reqJoSet = new Set(reqJos.map(j => j.fjobno));
  const stockJos = sorted.filter(
    s => s.stockAvailableCount > 0 && !blindSpotJoSet.has(s.fjobno) && !reqJoSet.has(s.fjobno) && s.partialCount === 0,
  );
  if (stockJos.length > 0) {
    w(`## Stock Available (needs kitting)`);
    w('');
    for (const jo of stockJos) {
      writeJoSection(jo, [BomLineStatus.STOCK_AVAILABLE], w);
    }
  }

  // On Order (exclude JOs in earlier sections)
  const stockJoSet = new Set(stockJos.map(j => j.fjobno));
  const shownJos = new Set([...blindSpotJoSet, ...reqJoSet, ...stockJoSet]);
  const onOrderJos = sorted.filter(
    s => s.onOrderCount > 0 && !shownJos.has(s.fjobno),
  );
  if (onOrderJos.length > 0) {
    w(`## On Order`);
    w('');
    for (const jo of onOrderJos) {
      writeJoSummaryLine(jo, w);
    }
    w('');
  }

  // No Action Needed (everything not in earlier sections)
  const onOrderJoSet = new Set(onOrderJos.map(j => j.fjobno));
  const allShownJos = new Set([...shownJos, ...onOrderJoSet]);
  const completeJos = sorted.filter(s => !allShownJos.has(s.fjobno));
  if (completeJos.length > 0) {
    w(`## No Action Needed (${completeJos.length} JOs)`);
    w('');
    w(`All BOM lines are complete, overissued, phantom (shop supply), or assemblies done — no shortages or open orders.`);
    w('');
    for (const jo of completeJos) {
      const parts: string[] = [];
      if (jo.completeCount > 0) parts.push(`${jo.completeCount} complete`);
      if (jo.overissuedCount > 0) parts.push(`${jo.overissuedCount} overissued`);
      if (jo.phantomCount > 0) parts.push(`${jo.phantomCount} phantom`);
      if (jo.makeCompleteCount > 0) parts.push(`${jo.makeCompleteCount} assy done`);
      const detail = parts.length > 1 ? ` (${parts.join(', ')})` : '';
      w(`- ${shortJobNo(jo.fjobno)}${detail}`);
    }
    w('');
  }

  // Internal (I) Job Orders — detail for blocked/in-progress assemblies
  const iJoMap = new Map<string, JoSummary>();
  for (const jo of summaries) {
    for (const line of jo.bomLines) {
      const subJo = (line as any).subJo as JoSummary | undefined;
      if (subJo && (line.status === BomLineStatus.MAKE_BLOCKED || line.status === BomLineStatus.MAKE_IN_PROGRESS)) {
        iJoMap.set(subJo.fjobno, subJo);
      }
    }
  }

  if (iJoMap.size > 0) {
    const iJos = [...iJoMap.values()].sort((a, b) => a.fjobno.localeCompare(b.fjobno));
    w(`## Internal Job Orders (Assemblies)`);
    w('');

    for (const ijo of iJos) {
      const shortIJo = ijo.fjobno.replace(/-0+$/, '');
      const pct = ijo.totalBomLines > 0 ? Math.round(ijo.completeCount / ijo.totalBomLines * 100) : 0;
      const hasBlind = ijo.blindSpotCount > 0;

      const ijoDesc = ijo.fdescript ? ` ${ijo.fdescript}` : '';
      w(`### ${shortIJo} — ${ijo.fpartno}${ijoDesc} ${hasBlind ? '🔴' : '🟡'}`);
      w('');
      // Kitting status line
      if (ijo.kittingStatus && ijo.kittingStatus !== 'NO_KITTING_OP') {
        const kitLabel = {
          'NOT_STARTED': `⬜ Kitting: Not Started (${ijo.kittingQtyToGo} to go)`,
          'IN_PROGRESS': `🟨 Kitting: In Progress (${ijo.kittingQtyComp} done, ${ijo.kittingQtyToGo} to go)`,
          'COMPLETE': '✅ Kitting: Complete',
        }[ijo.kittingStatus];
        w(kitLabel!);
      }
      const actionCounts: string[] = [];
      if (ijo.blindSpotCount > 0) actionCounts.push(`${ijo.blindSpotCount} blind spots`);
      if (ijo.onOrderCount > 0) actionCounts.push(`${ijo.onOrderCount} on order`);
      if (ijo.stockAvailableCount > 0) actionCounts.push(`${ijo.stockAvailableCount} stock avail`);
      if (ijo.phantomCount > 0) actionCounts.push(`${ijo.phantomCount} phantom`);
      w(`${ijo.fpartno} | ${ijo.completeCount}/${ijo.totalBomLines} complete (${pct}%) | ${actionCounts.join(' | ')}`);
      w('');

      // Show only lines that need action (exclude complete, overissued, phantom, stock avail, make done)
      const problemLines = ijo.bomLines.filter(l =>
        l.status === BomLineStatus.BLIND_SPOT ||
        l.status === BomLineStatus.ON_ORDER ||
        l.status === BomLineStatus.PARTIAL ||
        l.status === BomLineStatus.MAKE_BLOCKED ||
        l.status === BomLineStatus.MAKE_NO_JO,
      );

      if (problemLines.length > 0) {
        w(`| Part | Description | Need | Have | Gap | Status | POs | On Hand |`);
        w(`|------|-------------|------|------|-----|--------|-----|---------|`);
        for (const iLine of problemLines) {
          const pos = iLine.poNumbers.length > 0 ? iLine.poNumbers.join(', ') : '—';
          const onHand = iLine.onHandQty > 0 ? String(iLine.onHandQty) : '—';
          w(`| ${iLine.fbompart} | ${(iLine.fbomdesc || '').slice(0, 30)} | ${iLine.extendedQty} | ${iLine.totalSupplied} | ${iLine.gap} | ${iLine.status} | ${pos} | ${onHand} |`);
        }
      } else {
        w(`All remaining lines are on order or stock available.`);
      }
      w('');
    }
  }

  // Stock I JOs — internal jobs building inventory that have blind spots
  // Exclude ones already shown in the W JO assembly section
  if (allIJos.length > 0) {
    const referencedIJos = new Set<string>();
    for (const jo of summaries) {
      for (const line of jo.bomLines) {
        const subJo = (line as any).subJo as JoSummary | undefined;
        if (subJo) referencedIJos.add(subJo.fjobno);
      }
    }

    const stockIJos = allIJos
      .filter(ijo =>
        ijo.blindSpotCount > 0 &&
        !referencedIJos.has(ijo.fjobno) &&
        ijo.totalBomLines > 0,
      )
      .sort((a, b) => a.fjobno.localeCompare(b.fjobno));

    if (stockIJos.length > 0) {
      w(`## Stock Build I JOs with Blind Spots`);
      w('');
      w(`Internal jobs building to inventory — not tied to a specific W JO but have unresolved shortages.`);
      w('');

      for (const ijo of stockIJos) {
        const shortIJo = ijo.fjobno.replace(/-0+$/, '');
        const pct = ijo.totalBomLines > 0 ? Math.round(ijo.completeCount / ijo.totalBomLines * 100) : 0;

        const ijoDesc = ijo.fdescript ? ` ${ijo.fdescript}` : '';
        w(`### ${shortIJo} — ${ijo.fpartno}${ijoDesc}`);
        w('');
        if (ijo.kittingStatus && ijo.kittingStatus !== 'NO_KITTING_OP') {
          const kitLabel = {
            'NOT_STARTED': `⬜ Kitting: Not Started (${ijo.kittingQtyToGo} to go)`,
            'IN_PROGRESS': `🟨 Kitting: In Progress (${ijo.kittingQtyComp} done, ${ijo.kittingQtyToGo} to go)`,
            'COMPLETE': '✅ Kitting: Complete',
          }[ijo.kittingStatus];
          w(kitLabel!);
        }
        const stockActionCounts: string[] = [];
        if (ijo.blindSpotCount > 0) stockActionCounts.push(`${ijo.blindSpotCount} blind spots`);
        if (ijo.onOrderCount > 0) stockActionCounts.push(`${ijo.onOrderCount} on order`);
        if (ijo.stockAvailableCount > 0) stockActionCounts.push(`${ijo.stockAvailableCount} stock avail`);
        if (ijo.phantomCount > 0) stockActionCounts.push(`${ijo.phantomCount} phantom`);
        w(`${ijo.completeCount}/${ijo.totalBomLines} complete (${pct}%) | ${stockActionCounts.join(' | ')}`);
        w('');

        const problemLines = ijo.bomLines.filter(l =>
          l.status === BomLineStatus.BLIND_SPOT ||
          l.status === BomLineStatus.ON_ORDER ||
          l.status === BomLineStatus.PARTIAL ||
          l.status === BomLineStatus.MAKE_BLOCKED ||
          l.status === BomLineStatus.MAKE_NO_JO,
        );

        if (problemLines.length > 0) {
          w(`| Part | Description | Need | Have | Gap | Status | POs | On Hand |`);
          w(`|------|-------------|------|------|-----|--------|-----|---------|`);
          for (const iLine of problemLines) {
            const pos = iLine.poNumbers.length > 0 ? iLine.poNumbers.join(', ') : '—';
            const onHand = iLine.onHandQty > 0 ? String(iLine.onHandQty) : '—';
            w(`| ${iLine.fbompart} | ${(iLine.fbomdesc || '').slice(0, 30)} | ${iLine.extendedQty} | ${iLine.totalSupplied} | ${iLine.gap} | ${iLine.status} | ${pos} | ${onHand} |`);
          }
        }
        w('');
      }
    }
  }

  return lines.join('\n');
}

function writeJoSection(
  jo: JoSummary,
  filterStatus: BomLineStatus | BomLineStatus[],
  w: (s: string) => void,
) {
  const statusList = Array.isArray(filterStatus) ? filterStatus : [filterStatus];
  const shortJo = shortJobNo(jo.fjobno);
  const priority = jo.notionPriority || jo.fpriority || '';
  const tool = (jo as any).toolData as ToolData | undefined;
  // Customer name: Tool company > Notion traveler name (strip JO prefix) > M2M description
  let customerDesc = tool?.company || '';
  if (!customerDesc && jo.notionPageId) {
    // Notion name is like "W9434 Marathon - FL", strip the JO prefix
    const notionName = (jo as any)._notionName as string | undefined;
    if (notionName) customerDesc = notionName.replace(/^W\d{4,5}\s*/, '').trim();
  }
  if (!customerDesc || customerDesc === 'GOODS') customerDesc = jo.fdescript || jo.fpartno;

  // Quoted Delivery: prefer The Tool (col S), fall back to Notion/M2M
  const quotedDelivery = fmtDate(tool?.quotedDelivery || jo.notionPromisedShipDate || jo.fddue_date);
  const orderEntryDate = tool?.orderEntryDate ? fmtDate(tool.orderEntryDate) : '';

  w(`### ${shortJo} — ${customerDesc} <span style="color:#dc2626;font-size:0.85em">Quoted Delivery: ${quotedDelivery}</span>`);
  w('');

  // Summary line
  const meta: string[] = [`Qty: ${jo.fquantity}`];
  if (orderEntryDate) meta.push(`Order Entry: ${orderEntryDate}`);
  if (priority) meta.push(`Priority: ${priority}`);
  w(meta.join(' | '));

  // Sources context
  const context: string[] = [];
  if (jo.notionStatus) {
    let notionLine = `Notion: ${jo.notionStatus}`;
    if (jo.notionBlocker) notionLine += ` | Blocker: "${jo.notionBlocker}"`;
    context.push(notionLine);
  }
  if (tool) {
    let toolLine = `Tool: ${tool.statusPhase}`;
    if (tool.kittingNotes) toolLine += ` | Kit: "${tool.kittingNotes}"`;
    if (tool.lastPartDue) toolLine += ` | Last part: ${tool.lastPartDue}`;
    if (tool.willShip) toolLine += ` | Ship target: ${tool.willShip}`;
    context.push(toolLine);
  }
  if (jo.jiraReqKeys.length > 0) {
    context.push(`Jira: ${jo.jiraReqKeys.join(', ')}`);
  }

  // Status counts
  const counts: string[] = [];
  if (jo.blindSpotCount > 0) counts.push(`${jo.blindSpotCount} blind spots`);
  if (jo.makeBlockedCount > 0) counts.push(`${jo.makeBlockedCount} assy BLOCKED`);
  if (jo.makeNoJoCount > 0) counts.push(`${jo.makeNoJoCount} assy NO IJO`);
  if (jo.stockAvailableCount > 0) counts.push(`${jo.stockAvailableCount} stock avail`);
  if (jo.phantomCount > 0) counts.push(`${jo.phantomCount} phantom`);
  if (jo.requisitionedCount > 0) counts.push(`${jo.requisitionedCount} requisitioned`);
  if (jo.onOrderCount > 0) counts.push(`${jo.onOrderCount} on order`);
  counts.push(`${jo.completeCount} complete`);
  if (jo.makeInProgressCount > 0) counts.push(`${jo.makeInProgressCount} assy in-prog`);
  if (jo.makeCompleteCount > 0) counts.push(`${jo.makeCompleteCount} assy done`);
  context.push(counts.join(', '));

  // Kitting status for W JOs
  if (jo.kittingStatus && jo.kittingStatus !== 'NO_KITTING_OP') {
    const kitLabel = {
      'NOT_STARTED': `⬜ Kitting: Not Started (${jo.kittingQtyToGo} to go)`,
      'IN_PROGRESS': `🟨 Kitting: In Progress (${jo.kittingQtyComp} done, ${jo.kittingQtyToGo} to go)`,
      'COMPLETE': '✅ Kitting: Complete',
    }[jo.kittingStatus];
    context.push(kitLabel!);
  }

  for (const line of context) {
    w(line);
  }
  w('');

  // BOM line table
  w(`| Part | Description | Need | Have | Gap | Status | POs | Sys POs | On Hand |`);
  w(`|------|-------------|------|------|-----|--------|-----|---------|---------|`);

  // Show all lines that need action, not just the section's primary status
  const filteredLines = jo.bomLines.filter(l =>
    l.status === BomLineStatus.BLIND_SPOT ||
    l.status === BomLineStatus.REQUISITIONED ||
    l.status === BomLineStatus.STOCK_AVAILABLE ||
    l.status === BomLineStatus.ON_ORDER ||
    l.status === BomLineStatus.PARTIAL ||
    l.status === BomLineStatus.MAKE_BLOCKED ||
    l.status === BomLineStatus.MAKE_NO_JO ||
    l.status === BomLineStatus.MAKE_IN_PROGRESS,
  );
  for (const line of filteredLines) {
    const directPos = line.poNumbers.length > 0 ? line.poNumbers.join(', ') : '—';
    const sys = (line as any).systemPo as SystemPo | undefined;
    let sysPoStr = '—';
    if (sys && sys.totalOpen > 0) {
      const overdueTag = sys.overdueQty > 0 ? ' **OVERDUE**' : '';
      sysPoStr = `${sys.totalOpen} open${overdueTag}`;
    }
    const onHand = line.onHandQty > 0 ? String(line.onHandQty) : '—';

    const statusLabel = shortStatus(line.status);
    w(`| ${line.fbompart} | ${(line.fbomdesc || '').slice(0, 30)} | ${line.extendedQty} | ${line.totalSupplied} | ${line.gap} | ${statusLabel} | ${directPos} | ${sysPoStr} | ${onHand} |`);

    // Direct-to-JO PO overdue warnings
    const today = new Date().toISOString().slice(0, 10);
    for (const po of line.poDetails) {
      if (po.fordqty > po.frcpqty) {
        const dueDate = validDate(po.freqdate) || validDate(po.flstpdate);
        if (dueDate && dueDate < today) {
          const days = Math.floor((Date.now() - new Date(dueDate).getTime()) / 86400000);
          w(`| | ⚠️ PO ${po.fpono} direct-to-JO, ${po.fordqty - po.frcpqty} open, **${days}d overdue** | | | | | | | |`);
        }
      }
    }

    // System-wide overdue PO detail lines
    if (sys && sys.overdueQty > 0) {
      for (const po of sys.details.filter(d => d.isOverdue)) {
        const dest = po.fjokey || (po.fcategory === 'SO' ? 'SO' : 'INV');
        const daysStr = po.daysPastDue ? `${po.daysPastDue}d overdue` : 'overdue';
        w(`| | ⚠️ PO ${po.fpono} → ${dest} (${po.fvendno}) ${po.openQty} open, **${daysStr}** | | | | | | | |`);
      }
    }

    // Parsed Jira req annotation — only show if part was req'd but has NO system PO
    const parsedReqs = (line as any).parsedReqs as Array<{
      issue_key: string; qty: number; destination: string; destination_type: string; req_status: string;
    }> | undefined;
    const hasSysPo = sys && sys.totalOpen > 0;
    const activeParsedReqs = parsedReqs?.filter(r => r.req_status !== 'Confirmed');
    if (activeParsedReqs && activeParsedReqs.length > 0 && !hasSysPo) {
      // Deduplicate by issue key
      const seen = new Set<string>();
      const unique = activeParsedReqs.filter(r => { if (seen.has(r.issue_key)) return false; seen.add(r.issue_key); return true; });
      const reqList = unique.slice(0, 3).map(r => {
        const dest = r.destination ? `→${r.destination}` : '';
        return `${r.issue_key} (${r.req_status}) ${r.qty}ea${dest}`;
      }).join(', ');
      const more = unique.length > 3 ? ` +${unique.length - 3} more` : '';
      w(`| | 📋 Req'd but not on PO: ${reqList}${more} | | | | | | | |`);
    }

    // Assembly sub-JO inline callout (detail rendered in separate I JO section)
    const subJo = (line as any).subJo as JoSummary | undefined;
    if (line.status === BomLineStatus.MAKE_NO_JO) {
      w(`| | 🔴 No I JO found for assembly ${line.fbompart} | | | | | | | |`);
    } else if (subJo && (line.status === BomLineStatus.MAKE_BLOCKED || line.status === BomLineStatus.MAKE_IN_PROGRESS)) {
      const shortIJo = subJo.fjobno.replace(/-0+$/, '');
      const pct = subJo.totalBomLines > 0 ? Math.round(subJo.completeCount / subJo.totalBomLines * 100) : 0;
      const tag = line.status === BomLineStatus.MAKE_BLOCKED ? '🔴 BLOCKED' : '🟡';
      const subDesc = subJo.fdescript ? ` ${subJo.fdescript}` : '';
      w(`| | ${tag} See **${shortIJo}**${subDesc}: ${subJo.completeCount}/${subJo.totalBomLines} complete (${pct}%), ${subJo.blindSpotCount} blind spots | | | | | | | |`);
    }
  }
  w('');
}

function writeJoSummaryLine(
  jo: JoSummary,
  w: (s: string) => void,
) {
  const shortJo = shortJobNo(jo.fjobno);
  const tool = (jo as any).toolData as ToolData | undefined;
  const quotedDel = fmtDate(tool?.quotedDelivery || jo.notionPromisedShipDate || jo.fddue_date);
  const customerDesc = tool?.company || jo.fdescript || jo.fpartno;
  const notionStatus = jo.notionStatus ? ` | Notion: ${jo.notionStatus}` : '';
  const toolPhase = tool ? ` | Tool: ${tool.statusPhase}` : '';

  w(`- **${shortJo}** ${customerDesc} — ${jo.onOrderCount} on order, ${jo.completeCount} complete (<span style="color:#dc2626">Quoted Delivery: ${quotedDel}</span>${notionStatus}${toolPhase})`);
}

function fmtDate(d: string | null): string {
  if (!d) return 'N/A';
  return d.slice(0, 10);
}

function shortStatus(status: BomLineStatus): string {
  const map: Record<string, string> = {
    BLIND_SPOT: '**BLIND**',
    REQUISITIONED: 'REQ',
    STOCK_AVAILABLE: 'STOCK',
    ON_ORDER: 'ON ORDER',
    PARTIAL: 'PARTIAL',
    MAKE_BLOCKED: 'ASSY BLK',
    MAKE_NO_JO: 'NO IJO',
    MAKE_IN_PROGRESS: 'ASSY WIP',
    MAKE_COMPLETE: 'ASSY OK',
    COMPLETE: 'OK',
    OVERISSUED: 'OVER',
    PHANTOM: 'PHANTOM',
    MAKE: 'MAKE',
  };
  return map[status] || status;
}

function validDate(d: string | null): string | null {
  if (!d) return null;
  const s = d.slice(0, 10);
  if (s <= '1901-01-01') return null;
  return s;
}
