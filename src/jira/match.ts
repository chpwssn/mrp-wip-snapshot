import type Database from 'better-sqlite3';
import type { JoSummary } from '../analysis/types.js';
import { shortJobNo } from '../analysis/types.js';
import { BomLineStatus } from '../analysis/types.js';
import { logger } from '../utils/logger.js';

interface JiraReqMatch {
  key: string;
  summary: string;
  status: string;
}

export function matchBlindSpotsToRequisitions(
  db: Database.Database,
  snapshotId: number,
  summaries: JoSummary[],
): void {
  const blindSpotJos = summaries.filter(s => s.blindSpotCount > 0);
  if (blindSpotJos.length === 0) {
    logger.info('Jira match: no blind spots to match');
    return;
  }

  logger.info(`Jira match: checking ${blindSpotJos.length} JOs with blind spots against cached requisitions`);

  // Find open requisitions (not Done/Rejected/Confirmed) that mention each JO number
  const findReqs = db.prepare(`
    SELECT key, summary, status
    FROM jira_requisitions
    WHERE status_category NOT IN ('done')
      AND status NOT IN ('Confirmed')
      AND (',' || extracted_jo_numbers || ',') LIKE ('%,' || ? || ',%')
  `);

  const updateJoSummary = db.prepare(`
    UPDATE jo_summary SET
      jira_open_req_count = ?,
      jira_req_keys = ?
    WHERE snapshot_id = ? AND fjobno = ?
  `);

  // We upgrade BLIND_SPOT lines to REQUISITIONED when a matching req is found
  // This is at the JO level — we can't reliably match individual BOM lines to reqs
  const upgradeBomLines = db.prepare(`
    UPDATE bom_line_status SET status = 'REQUISITIONED'
    WHERE snapshot_id = ? AND fjobno = ? AND status = 'BLIND_SPOT'
  `);

  let matched = 0;

  const update = db.transaction(() => {
    for (const summary of blindSpotJos) {
      const shortJo = shortJobNo(summary.fjobno);
      const reqs = findReqs.all(shortJo) as JiraReqMatch[];

      if (reqs.length === 0) continue;

      matched++;
      const reqKeys = reqs.map(r => r.key);

      summary.jiraOpenReqCount = reqs.length;
      summary.jiraReqKeys = reqKeys;

      // Upgrade blind spots to requisitioned
      const upgradedCount = summary.blindSpotCount;
      summary.requisitionedCount += upgradedCount;
      summary.blindSpotCount = 0;
      for (const line of summary.bomLines) {
        if (line.status === BomLineStatus.BLIND_SPOT) {
          line.status = BomLineStatus.REQUISITIONED;
        }
      }

      updateJoSummary.run(reqs.length, reqKeys.join(','), snapshotId, summary.fjobno);
      upgradeBomLines.run(snapshotId, summary.fjobno);

      logger.debug(
        `${shortJo}: ${reqs.length} open req(s) found [${reqKeys.join(', ')}] — ` +
        `${upgradedCount} blind spots → requisitioned`,
      );
    }
  });

  update();
  logger.info(`Jira match: ${matched}/${blindSpotJos.length} blind-spot JOs matched to requisitions`);

  // Second pass: match blind spot PARTS against parsed req line items
  // This doesn't change status — it annotates with "this part was req'd in PUR-XXXX"
  annotateBlindSpotsFromParsedReqs(db, snapshotId, summaries);
}

interface ParsedReqMatch {
  issue_key: string;
  qty: number;
  destination: string;
  destination_type: string;
  format: string;
  req_status: string;
}

function annotateBlindSpotsFromParsedReqs(
  db: Database.Database,
  snapshotId: number,
  summaries: JoSummary[],
): void {
  // Find parsed req lines for a given part number, joined with req status
  const findParsedLines = db.prepare(`
    SELECT
      p.issue_key,
      p.qty,
      p.destination,
      p.destination_type,
      p.format,
      r.status as req_status
    FROM jira_parsed_req_lines p
    JOIN jira_requisitions r ON p.issue_key = r.key
    WHERE p.part_number = ?
      AND p.format NOT IN ('empty', 'error')
      AND p.qty > 0
      AND r.status NOT IN ('Confirmed')
    ORDER BY r.updated DESC
  `);

  // Collect unique blind spot part numbers
  const blindSpotParts = new Set<string>();
  for (const jo of summaries) {
    for (const line of jo.bomLines) {
      if (line.status === BomLineStatus.BLIND_SPOT && line.fbompart) {
        blindSpotParts.add(line.fbompart);
      }
    }
  }

  if (blindSpotParts.size === 0) return;

  // Build part → parsed req matches map
  const partReqMap = new Map<string, ParsedReqMatch[]>();
  for (const part of blindSpotParts) {
    const matches = findParsedLines.all(part) as ParsedReqMatch[];
    if (matches.length > 0) {
      partReqMap.set(part, matches);
    }
  }

  if (partReqMap.size === 0) {
    logger.info('Jira parsed req match: no blind spot parts found in parsed attachments');
    return;
  }

  // Annotate in-memory BOM lines with parsed req info
  let annotated = 0;
  for (const jo of summaries) {
    for (const line of jo.bomLines) {
      if (line.status !== BomLineStatus.BLIND_SPOT) continue;
      const matches = partReqMap.get(line.fbompart);
      if (!matches || matches.length === 0) continue;

      (line as any).parsedReqs = matches;
      annotated++;
    }
  }

  logger.info(
    `Jira parsed req match: ${partReqMap.size} blind-spot parts found in parsed attachments, ` +
    `${annotated} BOM lines annotated`,
  );
}
