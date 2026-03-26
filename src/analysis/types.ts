export enum BomLineStatus {
  COMPLETE = 'COMPLETE',
  ON_ORDER = 'ON_ORDER',
  PARTIAL = 'PARTIAL',
  BLIND_SPOT = 'BLIND_SPOT',
  REQUISITIONED = 'REQUISITIONED',
  MAKE = 'MAKE',                       // Legacy — replaced by specific MAKE_ statuses below
  MAKE_COMPLETE = 'MAKE_COMPLETE',     // I JO exists, all its BOM lines complete
  MAKE_IN_PROGRESS = 'MAKE_IN_PROGRESS', // I JO exists, has on-order/stock items but no blind spots
  MAKE_BLOCKED = 'MAKE_BLOCKED',       // I JO exists but has its own blind spots (cascading)
  MAKE_NO_JO = 'MAKE_NO_JO',          // No I JO found for this assembly
  OVERISSUED = 'OVERISSUED',
  PHANTOM = 'PHANTOM',
  STOCK_AVAILABLE = 'STOCK_AVAILABLE',
}

export interface PoDetail {
  fpono: string;
  fordqty: number;
  frcpqty: number;
  freqdate: string | null;
  flstpdate: string | null;
  fcomments: string;
}

export interface BomLineAnalysis {
  fjobno: string;
  fbompart: string;
  fbomrev: string;
  fbomdesc: string;
  fbominum: string;
  fbomsource: string;
  fparent: string;
  fparentrev: string;
  // Quantities
  factqty: number;
  joQuantity: number;
  extendedQty: number;
  fqtyIss: number;
  ftotqty: number;
  // PO aggregation
  poOrderedQty: number;
  poReceivedQty: number;
  poStillOnOrder: number;
  poNumbers: string[];
  poDetails: PoDetail[];
  // Gap
  totalSupplied: number;
  totalExpected: number;
  gap: number;
  // Classification
  status: BomLineStatus;
  // M2M metadata
  fresponse: string;
  fqtytopurc: number;
  fpono: string;
  fpoqty: number;
  // Inline part metadata
  fgroup: string;
  fprodcl: string;
  isPhantom: boolean;
  // Inline on-hand inventory
  onHandQty: number;
  onHandDetails: Array<{ qty: number; location: string; bin: string }>;
}

export interface JoSummary {
  fjobno: string;
  fpartno: string;
  fpartrev: string;
  fdescript: string;
  fquantity: number;
  fsono: string;
  fddue_date: string | null;
  fpriority: string;
  fstatus: string;
  fact_rel: string | null;
  fopen_dt: string | null;
  // Rollup counts
  totalBomLines: number;
  completeCount: number;
  onOrderCount: number;
  partialCount: number;
  blindSpotCount: number;
  requisitionedCount: number;
  overissuedCount: number;
  makeCount: number;
  makeCompleteCount: number;
  makeInProgressCount: number;
  makeBlockedCount: number;
  makeNoJoCount: number;
  phantomCount: number;
  stockAvailableCount: number;
  // Enrichment
  notionPageId?: string;
  notionStatus?: string;
  notionPriority?: string;
  notionBlocker?: string;
  notionPromisedShipDate?: string;
  notionBuildScheduleStart?: string;
  notionBuildScheduleEnd?: string;
  // Kitting status (from routing)
  kittingStatus?: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE' | 'NO_KITTING_OP';
  kittingQtyComp?: number;
  kittingQtyToGo?: number;
  // Jira
  jiraOpenReqCount: number;
  jiraReqKeys: string[];
  // BOM detail
  bomLines: BomLineAnalysis[];
}

/** Strip M2M -0000 suffix to get short JO number for Notion/Jira */
export function shortJobNo(fjobno: string): string {
  return fjobno.trim().replace(/-0+$/, '');
}
