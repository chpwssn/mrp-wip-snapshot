import type { GqlJodbom, GqlJomast } from '../graphql/types.js';
import { BomLineStatus, type BomLineAnalysis, type JoSummary, type PoDetail } from './types.js';

export function analyzeBomLine(bom: GqlJodbom, joQuantity: number): BomLineAnalysis {
  const factqty = bom.factqty || 0;
  const extendedQty = joQuantity * factqty;
  const fqtyIss = bom.fqty_iss || 0;

  // Aggregate PO data (only POs routed directly to this JO + BOM item)
  const poItems = bom.poitem ?? [];
  const poOrderedQty = poItems.reduce((sum, po) => sum + (po.fordqty || 0), 0);
  const poReceivedQty = poItems.reduce((sum, po) => sum + (po.frcpqty || 0), 0);
  const poStillOnOrder = poItems.reduce(
    (sum, po) => sum + Math.max(0, (po.fordqty || 0) - (po.frcpqty || 0)),
    0,
  );
  const poNumbers = [...new Set(poItems.map(po => po.fpono?.trim()).filter(Boolean))];
  const poDetails: PoDetail[] = poItems.map(po => ({
    fpono: po.fpono?.trim() || '',
    fordqty: po.fordqty || 0,
    frcpqty: po.frcpqty || 0,
    freqdate: po.freqdate,
    flstpdate: po.flstpdate,
    fcomments: po.fcomments || '',
  }));

  // Inline part metadata
  const fgroup = (bom.inmastx?.fgroup || '').trim();
  const fprodcl = (bom.inmastx?.fprodcl || '').trim();
  const isPhantom = fgroup === 'SUPPLY' || fprodcl === 'SS';

  // Inline on-hand inventory
  const inonhd = bom.inmastx?.inonhd ?? [];
  const onHandDetails = inonhd
    .filter(h => (h.fonhand || 0) > 0)
    .map(h => ({
      qty: h.fonhand || 0,
      location: (h.flocation || '').trim(),
      bin: (h.fbinno || '').trim(),
    }));
  const onHandQty = onHandDetails.reduce((s, d) => s + d.qty, 0);

  // Two supply paths combined
  const totalSupplied = fqtyIss + poReceivedQty;
  const totalExpected = totalSupplied + poStillOnOrder;
  const gap = extendedQty - totalExpected;
  const actualGap = Math.max(0, gap);

  // Classification
  let status: BomLineStatus;
  const source = (bom.fbomsource || '').trim();

  if (source === 'Make' || source === 'M') {
    status = BomLineStatus.MAKE;
  } else if (totalSupplied > extendedQty) {
    status = BomLineStatus.OVERISSUED;
  } else if (totalSupplied >= extendedQty) {
    status = BomLineStatus.COMPLETE;
  } else if (totalExpected >= extendedQty) {
    status = BomLineStatus.ON_ORDER;
  } else if (poStillOnOrder > 0) {
    status = BomLineStatus.PARTIAL;
  } else if (isPhantom) {
    // Shop supply — consumed from inventory, not formally issued to JOs
    status = BomLineStatus.PHANTOM;
  } else if (onHandQty >= actualGap && actualGap > 0) {
    // On-hand inventory could cover the gap — kitting issue, not supply issue
    status = BomLineStatus.STOCK_AVAILABLE;
  } else {
    status = BomLineStatus.BLIND_SPOT;
  }

  return {
    fjobno: (bom.fjobno || bom.jomast?.fjobno || '').trim(),
    fbompart: (bom.fbompart || '').trim(),
    fbomrev: (bom.fbomrev || '').trim(),
    fbomdesc: (bom.fbomdesc || '').trim(),
    fbominum: (bom.fbominum || '').trim(),
    fbomsource: source,
    fparent: (bom.fparent || '').trim(),
    fparentrev: (bom.fparentrev || '').trim(),
    factqty,
    joQuantity,
    extendedQty,
    fqtyIss,
    ftotqty: bom.ftotqty || 0,
    poOrderedQty,
    poReceivedQty,
    poStillOnOrder,
    poNumbers,
    poDetails,
    totalSupplied,
    totalExpected,
    gap: actualGap,
    status,
    fresponse: (bom.fresponse || '').trim(),
    fqtytopurc: bom.fqtytopurc || 0,
    fpono: (bom.fpono || '').trim(),
    fpoqty: bom.fpoqty || 0,
    fgroup,
    fprodcl,
    isPhantom,
    onHandQty,
    onHandDetails,
  };
}

export function summarizeJo(jo: GqlJomast, bomLines: BomLineAnalysis[]): JoSummary {
  const counts = {
    complete: 0,
    onOrder: 0,
    partial: 0,
    blindSpot: 0,
    requisitioned: 0,
    overissued: 0,
    make: 0,
    makeComplete: 0,
    makeInProgress: 0,
    makeBlocked: 0,
    makeNoJo: 0,
    phantom: 0,
    stockAvailable: 0,
  };

  for (const line of bomLines) {
    switch (line.status) {
      case BomLineStatus.COMPLETE: counts.complete++; break;
      case BomLineStatus.ON_ORDER: counts.onOrder++; break;
      case BomLineStatus.PARTIAL: counts.partial++; break;
      case BomLineStatus.BLIND_SPOT: counts.blindSpot++; break;
      case BomLineStatus.REQUISITIONED: counts.requisitioned++; break;
      case BomLineStatus.OVERISSUED: counts.overissued++; break;
      case BomLineStatus.MAKE: counts.make++; break;
      case BomLineStatus.MAKE_COMPLETE: counts.makeComplete++; break;
      case BomLineStatus.MAKE_IN_PROGRESS: counts.makeInProgress++; break;
      case BomLineStatus.MAKE_BLOCKED: counts.makeBlocked++; break;
      case BomLineStatus.MAKE_NO_JO: counts.makeNoJo++; break;
      case BomLineStatus.PHANTOM: counts.phantom++; break;
      case BomLineStatus.STOCK_AVAILABLE: counts.stockAvailable++; break;
    }
  }

  return {
    fjobno: jo.fjobno?.trim() || '',
    fpartno: jo.fpartno?.trim() || '',
    fpartrev: jo.fpartrev?.trim() || '',
    fdescript: jo.fdescript?.trim() || '',
    fquantity: jo.fquantity || 0,
    fsono: jo.fsono?.trim() || '',
    fddue_date: jo.fddue_date,
    fpriority: jo.fpriority?.trim() || '',
    fstatus: jo.fstatus?.trim() || '',
    fact_rel: jo.fact_rel,
    fopen_dt: jo.fopen_dt,
    totalBomLines: bomLines.length,
    completeCount: counts.complete,
    onOrderCount: counts.onOrder,
    partialCount: counts.partial,
    blindSpotCount: counts.blindSpot,
    requisitionedCount: counts.requisitioned,
    overissuedCount: counts.overissued,
    makeCount: counts.make,
    makeCompleteCount: counts.makeComplete,
    makeInProgressCount: counts.makeInProgress,
    makeBlockedCount: counts.makeBlocked,
    makeNoJoCount: counts.makeNoJo,
    phantomCount: counts.phantom,
    stockAvailableCount: counts.stockAvailable,
    jiraOpenReqCount: 0,
    jiraReqKeys: [],
    bomLines,
  };
}
