import type Database from 'better-sqlite3';
import type { Config } from '../utils/config.js';
import { isJiraConfigured } from '../utils/config.js';
import type { JoSummary } from '../analysis/types.js';
import { JiraClient } from '../jira/client.js';
import { syncJiraRequisitions } from '../jira/sync.js';
import { matchBlindSpotsToRequisitions } from '../jira/match.js';
import { parseAttachments } from '../jira/parse-attachments.js';
import { logger } from '../utils/logger.js';

export async function enrichWithJira(
  config: Config,
  db: Database.Database,
  snapshotId: number,
  summaries: JoSummary[],
): Promise<void> {
  if (!isJiraConfigured(config)) {
    logger.info('Jira not configured — skipping requisition sync and matching');
    return;
  }

  const client = new JiraClient(
    config.jiraCloudId!,
    config.jiraEmail!,
    config.jiraApiToken!,
  );

  // Step 1: Incremental sync of PUR requisitions into local cache
  await syncJiraRequisitions(client, db);

  // Step 2: Download and parse attachments (XLSX + PDF)
  await parseAttachments(client, db);

  // Step 3: Match cached requisitions against blind spots
  matchBlindSpotsToRequisitions(db, snapshotId, summaries);
}
