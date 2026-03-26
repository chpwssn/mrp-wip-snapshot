import type Database from 'better-sqlite3';
import { GraphQLClient } from '../graphql/client.js';
import { GET_RELEASED_JOS, GET_JODBOM_WITH_POS, GET_JO_ROUTING } from '../graphql/queries.js';
import type { GqlJobOrdersResponse, GqlJodbomResponse, GqlJomast } from '../graphql/types.js';
import { analyzeBomLine, summarizeJo } from '../analysis/shortage-calculator.js';
import { BomLineStatus } from '../analysis/types.js';
import type { JoSummary, BomLineAnalysis } from '../analysis/types.js';
import { logger } from '../utils/logger.js';
import type { Config } from '../utils/config.js';

export async function collectM2mShortages(
  config: Config,
  db: Database.Database,
  snapshotId: number,
): Promise<JoSummary[]> {
  const client = new GraphQLClient(config.m2mGraphqlUrl);

  // Phase 1: Get ALL released JOs (W + I + others)
  logger.info('Fetching released Job Orders...');
  const josData = await client.query<GqlJobOrdersResponse>(GET_RELEASED_JOS);
  const allJos = josData.getJobOrdersWhere ?? [];

  const wJobs = allJos.filter(jo => jo.fjobno?.trim().startsWith('W'));
  const iJobs = allJos.filter(jo => jo.fjobno?.trim().startsWith('I'));
  logger.info(`Found ${wJobs.length} W JOs, ${iJobs.length} I JOs (${allJos.length} total released)`);

  // Phase 2: Fetch and analyze I JOs first (we need their status for assembly resolution)
  logger.info('Analyzing I (internal/assembly) Job Orders...');
  const iSummaries = await fetchAndAnalyzeBatch(client, iJobs, config);
  logger.info(`I JO analysis: ${iSummaries.length} processed`);

  // Fetch kitting status for I JOs
  logger.info('Fetching kitting status for I JOs...');
  await fetchKittingStatus(client, iSummaries, config);

  // Build assembly part → I JO summary map
  const assemblyMap = buildAssemblyMap(iSummaries);
  logger.info(`Assembly map: ${assemblyMap.size} unique assembly parts with I JOs`);

  // Phase 3: Fetch and analyze W JOs
  logger.info('Analyzing W (production) Job Orders...');
  const wSummaries = await fetchAndAnalyzeBatch(client, wJobs, config);

  // Phase 4: Resolve assembly (A-prefix) BOM lines using I JO data
  resolveAssemblies(wSummaries, assemblyMap);

  // Log assembly resolution stats
  let makeComplete = 0, makeInProgress = 0, makeBlocked = 0, makeNoJo = 0;
  for (const s of wSummaries) {
    makeComplete += s.makeCompleteCount;
    makeInProgress += s.makeInProgressCount;
    makeBlocked += s.makeBlockedCount;
    makeNoJo += s.makeNoJoCount;
  }
  logger.info(
    `Assembly resolution: ${makeComplete} complete, ${makeInProgress} in progress, ` +
    `${makeBlocked} BLOCKED (cascading), ${makeNoJo} no I JO found`,
  );

  // Phase 5: Store W JO results to SQLite (I JOs stored separately for reference)
  storeResults(db, snapshotId, wSummaries);
  storeIJoResults(db, iSummaries);

  // Update snapshot with error count
  db.prepare('UPDATE snapshots SET error_count = 0 WHERE id = ?').run(snapshotId);

  // Attach I JO summaries for report rendering
  (wSummaries as any).__ijoSummaries = iSummaries;

  return wSummaries;
}

async function fetchAndAnalyzeBatch(
  client: GraphQLClient,
  jobs: GqlJomast[],
  config: Config,
): Promise<JoSummary[]> {
  const summaries: JoSummary[] = [];
  const batches = chunk(jobs, config.concurrency);
  let processed = 0;

  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map(jo => fetchAndAnalyzeJo(client, jo)),
    );

    for (const result of results) {
      processed++;
      if (result.status === 'fulfilled') {
        summaries.push(result.value);
      } else {
        logger.error(`[${processed}/${jobs.length}] Failed:`, result.reason);
      }
    }

    if (batches.indexOf(batch) < batches.length - 1) {
      await sleep(config.batchDelayMs);
    }
  }

  return summaries;
}

async function fetchAndAnalyzeJo(
  client: GraphQLClient,
  jo: GqlJomast,
): Promise<JoSummary> {
  const fjobno = jo.fjobno.trim();

  const data = await client.query<GqlJodbomResponse>(GET_JODBOM_WITH_POS, {
    jobOrder: fjobno,
  });

  const jodboms = data.getJodbomsWhere ?? [];
  const joQuantity = jodboms[0]?.jomast?.fquantity ?? jo.fquantity ?? 1;

  const bomLines: BomLineAnalysis[] = jodboms.map(bom =>
    analyzeBomLine(bom, joQuantity),
  );

  for (const line of bomLines) {
    if (!line.fjobno) line.fjobno = fjobno;
  }

  return summarizeJo(jo, bomLines);
}

/** Fetch routing for I JOs and extract kitting work center status */
async function fetchKittingStatus(
  client: GraphQLClient,
  iSummaries: JoSummary[],
  config: Config,
): Promise<void> {
  const batches = chunk(iSummaries, config.concurrency);

  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map(async ijo => {
        const data = await client.query<{
          getJobOrdersWhere: Array<{
            fjobno: string;
            jodrtg: Array<{
              foperno: number;
              fpro_id: string;
              fcstat: string;
              fnqty_comp: number;
              fnqty_togo: number;
            }> | null;
          }>;
        }>(GET_JO_ROUTING, { jobOrder: ijo.fjobno });

        const job = data.getJobOrdersWhere?.[0];
        if (!job?.jodrtg) return;

        const kittingOp = job.jodrtg.find(
          op => (op.fpro_id || '').trim().toUpperCase() === 'KITTING',
        );

        if (!kittingOp) {
          ijo.kittingStatus = 'NO_KITTING_OP';
        } else if (kittingOp.fnqty_togo <= 0) {
          ijo.kittingStatus = 'COMPLETE';
          ijo.kittingQtyComp = kittingOp.fnqty_comp;
          ijo.kittingQtyToGo = 0;
        } else if (kittingOp.fnqty_comp > 0) {
          ijo.kittingStatus = 'IN_PROGRESS';
          ijo.kittingQtyComp = kittingOp.fnqty_comp;
          ijo.kittingQtyToGo = kittingOp.fnqty_togo;
        } else {
          ijo.kittingStatus = 'NOT_STARTED';
          ijo.kittingQtyComp = 0;
          ijo.kittingQtyToGo = kittingOp.fnqty_togo;
        }
      }),
    );

    if (batches.indexOf(batch) < batches.length - 1) {
      await sleep(config.batchDelayMs);
    }
  }

  // Log summary
  const counts = { complete: 0, inProgress: 0, notStarted: 0, noOp: 0 };
  for (const ijo of iSummaries) {
    switch (ijo.kittingStatus) {
      case 'COMPLETE': counts.complete++; break;
      case 'IN_PROGRESS': counts.inProgress++; break;
      case 'NOT_STARTED': counts.notStarted++; break;
      case 'NO_KITTING_OP': counts.noOp++; break;
    }
  }
  logger.info(
    `Kitting status: ${counts.complete} complete, ${counts.inProgress} in progress, ` +
    `${counts.notStarted} not started, ${counts.noOp} no kitting op`,
  );
}

/** Build a map from assembly part number → I JO summary */
function buildAssemblyMap(iSummaries: JoSummary[]): Map<string, JoSummary[]> {
  const map = new Map<string, JoSummary[]>();
  for (const ijo of iSummaries) {
    const partno = ijo.fpartno;
    if (!partno) continue;
    if (!map.has(partno)) map.set(partno, []);
    map.get(partno)!.push(ijo);
  }
  return map;
}

/** Resolve A-prefix BOM lines on W JOs using I JO analysis */
function resolveAssemblies(wSummaries: JoSummary[], assemblyMap: Map<string, JoSummary[]>) {
  for (const wjo of wSummaries) {
    for (const line of wjo.bomLines) {
      // Resolve any A-prefix part that isn't already fully supplied
      if (!line.fbompart.startsWith('A')) continue;
      if (line.status === BomLineStatus.COMPLETE || line.status === BomLineStatus.OVERISSUED) continue;
      if (line.status === BomLineStatus.PHANTOM) continue;

      const iJos = assemblyMap.get(line.fbompart);

      if (!iJos || iJos.length === 0) {
        line.status = BomLineStatus.MAKE_NO_JO;
        continue;
      }

      // Find the best matching I JO (prefer one with most completeness)
      const bestIJo = iJos.reduce((best, curr) => {
        const bestPct = best.totalBomLines > 0 ? best.completeCount / best.totalBomLines : 0;
        const currPct = curr.totalBomLines > 0 ? curr.completeCount / curr.totalBomLines : 0;
        return currPct > bestPct ? curr : best;
      });

      // Attach the I JO reference for reporting
      (line as any).subJo = bestIJo;

      if (bestIJo.blindSpotCount > 0 || bestIJo.makeBlockedCount > 0) {
        line.status = BomLineStatus.MAKE_BLOCKED;
      } else if (bestIJo.totalBomLines === 0 || bestIJo.completeCount >= bestIJo.totalBomLines) {
        line.status = BomLineStatus.MAKE_COMPLETE;
      } else {
        line.status = BomLineStatus.MAKE_IN_PROGRESS;
      }
    }

    // Recount after resolution
    recountSummary(wjo);
  }
}

/** Recount all statuses from scratch after assembly resolution */
function recountSummary(jo: JoSummary) {
  jo.completeCount = 0;
  jo.onOrderCount = 0;
  jo.partialCount = 0;
  jo.blindSpotCount = 0;
  jo.requisitionedCount = 0;
  jo.overissuedCount = 0;
  jo.makeCount = 0;
  jo.makeCompleteCount = 0;
  jo.makeInProgressCount = 0;
  jo.makeBlockedCount = 0;
  jo.makeNoJoCount = 0;
  jo.phantomCount = 0;
  jo.stockAvailableCount = 0;

  for (const line of jo.bomLines) {
    switch (line.status) {
      case BomLineStatus.COMPLETE: jo.completeCount++; break;
      case BomLineStatus.ON_ORDER: jo.onOrderCount++; break;
      case BomLineStatus.PARTIAL: jo.partialCount++; break;
      case BomLineStatus.BLIND_SPOT: jo.blindSpotCount++; break;
      case BomLineStatus.REQUISITIONED: jo.requisitionedCount++; break;
      case BomLineStatus.OVERISSUED: jo.overissuedCount++; break;
      case BomLineStatus.MAKE: jo.makeCount++; break;
      case BomLineStatus.MAKE_COMPLETE: jo.makeCompleteCount++; break;
      case BomLineStatus.MAKE_IN_PROGRESS: jo.makeInProgressCount++; break;
      case BomLineStatus.MAKE_BLOCKED: jo.makeBlockedCount++; break;
      case BomLineStatus.MAKE_NO_JO: jo.makeNoJoCount++; break;
      case BomLineStatus.PHANTOM: jo.phantomCount++; break;
      case BomLineStatus.STOCK_AVAILABLE: jo.stockAvailableCount++; break;
    }
  }
}

function storeResults(
  db: Database.Database,
  snapshotId: number,
  summaries: JoSummary[],
) {
  const insertJo = db.prepare(`
    INSERT INTO jo_summary (
      snapshot_id, fjobno, fpartno, fpartrev, fdescript, fquantity, fsono,
      fddue_date, fpriority, fstatus, fact_rel, fopen_dt,
      total_bom_lines, complete_count, on_order_count, partial_count,
      blind_spot_count, requisitioned_count, overissued_count, make_count,
      make_complete_count, make_in_progress_count, make_blocked_count, make_no_jo_count,
      phantom_count, stock_available_count
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
  `);

  const insertBom = db.prepare(`
    INSERT INTO bom_line_status (
      snapshot_id, fjobno, fbompart, fbomrev, fbomdesc, fbominum, fbomsource,
      fparent, fparentrev,
      factqty, fquantity, extended_qty, fqty_iss, ftotqty,
      po_ordered_qty, po_received_qty, po_still_on_order, po_numbers,
      total_supplied, total_expected, gap, status,
      fresponse, fqtytopurc, fpono, fpoqty, po_details_json,
      fgroup, fprodcl, is_phantom, on_hand_qty, on_hand_details_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `);

  const insertAll = db.transaction(() => {
    for (const summary of summaries) {
      insertJo.run(
        snapshotId, summary.fjobno, summary.fpartno, summary.fpartrev,
        summary.fdescript, summary.fquantity, summary.fsono,
        summary.fddue_date, summary.fpriority, summary.fstatus,
        summary.fact_rel, summary.fopen_dt,
        summary.totalBomLines, summary.completeCount, summary.onOrderCount,
        summary.partialCount, summary.blindSpotCount, summary.requisitionedCount,
        summary.overissuedCount, summary.makeCount,
        summary.makeCompleteCount, summary.makeInProgressCount,
        summary.makeBlockedCount, summary.makeNoJoCount,
        summary.phantomCount, summary.stockAvailableCount,
      );

      for (const line of summary.bomLines) {
        insertBom.run(
          snapshotId, line.fjobno, line.fbompart, line.fbomrev, line.fbomdesc,
          line.fbominum, line.fbomsource, line.fparent, line.fparentrev,
          line.factqty, line.joQuantity, line.extendedQty, line.fqtyIss, line.ftotqty,
          line.poOrderedQty, line.poReceivedQty, line.poStillOnOrder,
          line.poNumbers.join(','),
          line.totalSupplied, line.totalExpected, line.gap, line.status,
          line.fresponse, line.fqtytopurc, line.fpono, line.fpoqty,
          JSON.stringify(line.poDetails),
          line.fgroup, line.fprodcl, line.isPhantom ? 1 : 0,
          line.onHandQty, JSON.stringify(line.onHandDetails),
        );
      }
    }
  });

  insertAll();
  logger.info(`Stored ${summaries.length} W JO summaries and ${summaries.reduce((s, j) => s + j.bomLines.length, 0)} BOM lines`);
}

/** Store I JO analysis for reference (not in snapshot, just cached) */
function storeIJoResults(db: Database.Database, iSummaries: JoSummary[]) {
  // Create a simple cache table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS ijo_cache (
      fjobno TEXT PRIMARY KEY,
      fpartno TEXT,
      total_bom_lines INTEGER,
      complete_count INTEGER,
      blind_spot_count INTEGER,
      on_order_count INTEGER,
      make_blocked_count INTEGER,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO ijo_cache (
      fjobno, fpartno, total_bom_lines, complete_count,
      blind_spot_count, on_order_count, make_blocked_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insert = db.transaction(() => {
    for (const ijo of iSummaries) {
      upsert.run(
        ijo.fjobno, ijo.fpartno, ijo.totalBomLines,
        ijo.completeCount, ijo.blindSpotCount,
        ijo.onOrderCount, ijo.makeBlockedCount,
      );
    }
  });

  insert();
  logger.info(`Cached ${iSummaries.length} I JO analyses`);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
