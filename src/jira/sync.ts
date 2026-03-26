import type Database from 'better-sqlite3';
import { JiraClient, type JiraIssue } from './client.js';
import { extractJobNumbers, extractSalesOrderNumbers, extractPartNumbers, isXlsxFile, isMeaningfulAttachment, combineText } from './extract.js';
import { logger } from '../utils/logger.js';

const INITIAL_SYNC_DATE = '2025-10-01';

export async function syncJiraRequisitions(
  client: JiraClient,
  db: Database.Database,
): Promise<{ synced: number; total: number }> {
  const lastSync = getLastSyncDate(db);
  const sinceDate = lastSync || INITIAL_SYNC_DATE;
  logger.info(`Jira sync: fetching issues updated since ${sinceDate}`);

  const upsertReq = db.prepare(`
    INSERT INTO jira_requisitions (
      key, issue_id, summary, description, status, status_category,
      reporter, assignee, priority, created, updated,
      extracted_jo_numbers, extracted_so_numbers, extracted_part_numbers,
      synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      summary = excluded.summary,
      description = excluded.description,
      status = excluded.status,
      status_category = excluded.status_category,
      reporter = excluded.reporter,
      assignee = excluded.assignee,
      priority = excluded.priority,
      updated = excluded.updated,
      extracted_jo_numbers = excluded.extracted_jo_numbers,
      extracted_so_numbers = excluded.extracted_so_numbers,
      extracted_part_numbers = excluded.extracted_part_numbers,
      synced_at = datetime('now')
  `);

  const insertAttach = db.prepare(`
    INSERT OR IGNORE INTO jira_requisition_attachments (
      attachment_id, issue_key, filename, mime_type, size, is_xlsx, created, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const upsertSubtask = db.prepare(`
    INSERT INTO jira_po_subtasks (
      key, issue_id, parent_key, summary, status, status_category,
      assignee, created, updated, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      summary = excluded.summary,
      status = excluded.status,
      status_category = excluded.status_category,
      assignee = excluded.assignee,
      updated = excluded.updated,
      synced_at = datetime('now')
  `);

  let synced = 0;
  let totalIssues = 0;
  let nextPageToken: string | undefined;
  const pageSize = 50;

  // Fetch all issue types (Requisitions + PO subtasks + PO Follow Up)
  const jql = `project = PUR AND updated >= "${sinceDate}" ORDER BY updated ASC`;

  do {
    const response = await client.searchJql(jql, {
      fields: [
        'summary', 'description', 'status', 'issuetype', 'priority',
        'reporter', 'assignee', 'created', 'updated', 'parent',
        'attachment', 'subtasks',
      ],
      maxResults: pageSize,
      nextPageToken,
    });

    const batchInsert = db.transaction(() => {
      for (const issue of response.issues) {
        const issueType = issue.fields.issuetype?.name || '';

        if (issueType === 'Requisition') {
          processRequisition(issue, upsertReq, insertAttach);
          // Also process inline subtasks if returned
          if (issue.fields.subtasks) {
            for (const sub of issue.fields.subtasks) {
              upsertSubtask.run(
                sub.key, '', issue.key, sub.fields.summary,
                sub.fields.status.name, sub.fields.status.statusCategory?.key || '',
                '', '', '',
              );
            }
          }
        } else if (issueType === 'Purchase Order (S)') {
          processPoSubtask(issue, upsertSubtask);
        } else if (issueType === 'PO Follow Up Request') {
          // Treat like a requisition for search purposes
          processRequisition(issue, upsertReq, insertAttach);
        }

        synced++;
      }
    });

    batchInsert();
    nextPageToken = response.nextPageToken;
    totalIssues = response.total || synced;
    logger.debug(`Jira sync: ${synced}/${totalIssues} issues processed`);

    // Small delay between pages
    if (nextPageToken) {
      await new Promise(r => setTimeout(r, 100));
    }
  } while (nextPageToken);

  // Update sync state
  updateSyncDate(db);
  logger.info(`Jira sync complete: ${synced} issues synced (${totalIssues} total matching)`);

  // Log XLSX attachment count for visibility
  const xlsxCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM jira_requisition_attachments WHERE is_xlsx = 1',
  ).get() as { cnt: number };
  if (xlsxCount.cnt > 0) {
    logger.info(`${xlsxCount.cnt} XLSX attachment(s) in cache (will be parsed in attachment phase)`);
  }

  return { synced, total: totalIssues };
}

function processRequisition(
  issue: JiraIssue,
  upsertReq: Database.Statement,
  insertAttach: Database.Statement,
) {
  // Jira v3 returns description as ADF (JSON object), not string — stringify for text extraction
  const descRaw = issue.fields.description;
  const descText = typeof descRaw === 'string' ? descRaw : (descRaw ? JSON.stringify(descRaw) : '');
  const text = combineText(issue.fields.summary, descText);
  const joNums = extractJobNumbers(text);
  const soNums = extractSalesOrderNumbers(text);
  const partNums = extractPartNumbers(text);

  upsertReq.run(
    issue.key,
    issue.id,
    issue.fields.summary || '',
    descText.slice(0, 2000), // Truncate large descriptions
    issue.fields.status?.name || '',
    issue.fields.status?.statusCategory?.key || '',
    issue.fields.reporter?.displayName || '',
    issue.fields.assignee?.displayName || '',
    issue.fields.priority?.name || '',
    issue.fields.created || '',
    issue.fields.updated || '',
    joNums.join(','),
    soNums.join(','),
    partNums.join(','),
  );

  // Process attachments (immutable — insert or ignore)
  for (const att of issue.fields.attachment ?? []) {
    if (!isMeaningfulAttachment(att.filename, att.mimeType)) continue;
    insertAttach.run(
      att.id, issue.key, att.filename, att.mimeType, att.size,
      isXlsxFile(att.filename) ? 1 : 0,
      att.created,
    );
  }
}

function processPoSubtask(issue: JiraIssue, upsertSubtask: Database.Statement) {
  upsertSubtask.run(
    issue.key,
    issue.id,
    issue.fields.parent?.key || '',
    issue.fields.summary || '',
    issue.fields.status?.name || '',
    issue.fields.status?.statusCategory?.key || '',
    issue.fields.assignee?.displayName || '',
    issue.fields.created || '',
    issue.fields.updated || '',
  );
}

function getLastSyncDate(db: Database.Database): string | null {
  const row = db.prepare('SELECT last_sync_at FROM jira_sync_state WHERE id = 1').get() as
    | { last_sync_at: string }
    | undefined;
  return row?.last_sync_at || null;
}

function updateSyncDate(db: Database.Database) {
  db.prepare(`
    INSERT INTO jira_sync_state (id, last_sync_at, issues_synced)
    VALUES (1, datetime('now'), 0)
    ON CONFLICT(id) DO UPDATE SET
      last_sync_at = datetime('now'),
      issues_synced = issues_synced + 1
  `).run();
}
