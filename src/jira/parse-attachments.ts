import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { JiraClient } from './client.js';
import { parseXlsx } from './xlsx-parser.js';
import { parsePdf } from './pdf-parser.js';
import { isMeaningfulAttachment } from './extract.js';
import { logger } from '../utils/logger.js';

interface UnparsedAttachment {
  attachment_id: string;
  issue_key: string;
  filename: string;
  mime_type: string;
}

const ATTACHMENTS_DIR = './data/attachments';

function ensureAttachmentsDir() {
  if (!existsSync(ATTACHMENTS_DIR)) {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }
}

function attachmentPath(attachmentId: string, filename: string): string {
  // Use attachment ID prefix to avoid filename collisions
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
  return join(ATTACHMENTS_DIR, `${attachmentId}${ext}`);
}

/**
 * Download and parse all meaningful unprocessed attachments (XLSX + PDF).
 * Files are cached to disk so they're never re-downloaded.
 */
export async function parseAttachments(
  client: JiraClient,
  db: Database.Database,
): Promise<{ parsed: number; lines: number }> {
  ensureAttachmentsDir();

  // Find attachments that haven't been parsed yet
  const unparsed = db.prepare(`
    SELECT a.attachment_id, a.issue_key, a.filename, a.mime_type
    FROM jira_requisition_attachments a
    WHERE a.attachment_id NOT IN (
      SELECT DISTINCT attachment_id FROM jira_parsed_req_lines
    )
    ORDER BY a.issue_key DESC
  `).all() as UnparsedAttachment[];

  // Filter to meaningful attachments (skip email signature images)
  const toProcess = unparsed.filter(a =>
    isMeaningfulAttachment(a.filename, a.mime_type) &&
    (a.mime_type === 'application/pdf' ||
     a.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
     a.filename.match(/\.xlsx?$/i)),
  );

  if (toProcess.length === 0) {
    logger.info('No new attachments to parse');
    return { parsed: 0, lines: 0 };
  }

  logger.info(`Processing ${toProcess.length} attachment(s) (${unparsed.length - toProcess.length} skipped as non-parseable)...`);

  const insertLine = db.prepare(`
    INSERT INTO jira_parsed_req_lines (
      issue_key, attachment_id, format, sheet_name, row_number,
      part_number, part_rev, description, qty, vendor, vendor_part,
      vendor_qty, unit_cost, destination, destination_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalParsed = 0;
  let totalLines = 0;

  for (const att of toProcess) {
    try {
      // Check disk cache first
      const diskPath = attachmentPath(att.attachment_id, att.filename);
      let buffer: Buffer;

      if (existsSync(diskPath)) {
        buffer = readFileSync(diskPath);
        logger.debug(`Cache hit: ${att.filename}`);
      } else {
        buffer = await client.downloadAttachment(att.attachment_id);
        writeFileSync(diskPath, buffer);
        logger.debug(`Downloaded: ${att.filename} (${buffer.length} bytes)`);
        // Rate limit downloads
        await new Promise(r => setTimeout(r, 200));
      }

      // Parse based on type
      let lines: import('./xlsx-parser.js').ParsedReqLine[];
      if (att.filename.match(/\.xlsx?$/i)) {
        lines = parseXlsx(buffer, att.filename, att.issue_key);
      } else if (att.mime_type === 'application/pdf') {
        lines = await parsePdf(buffer, att.filename, att.issue_key);
      } else {
        lines = [];
      }

      // Store results
      const insertBatch = db.transaction(() => {
        if (lines.length > 0) {
          for (const line of lines) {
            insertLine.run(
              att.issue_key, att.attachment_id, line.format, line.sheetName,
              line.rowNumber, line.partNumber, line.partRev, line.description,
              line.qty, line.vendor, line.vendorPart, line.vendorQty,
              line.unitCost, line.destination, line.destinationType,
            );
          }
        } else {
          // Sentinel row to prevent re-processing
          insertLine.run(
            att.issue_key, att.attachment_id, 'empty', '', 0,
            '', '', '', 0, '', '', 0, 0, '', 'UNKNOWN',
          );
        }
      });
      insertBatch();

      totalParsed++;
      totalLines += lines.length;

      if (lines.length > 0) {
        logger.debug(`${att.filename} (${att.issue_key}): ${lines.length} lines [${lines[0].format}]`);
      }
    } catch (err) {
      logger.warn(`Failed to process ${att.filename} (${att.issue_key}):`, err);
      // Insert sentinel to avoid retrying
      try {
        insertLine.run(
          att.issue_key, att.attachment_id, 'error', '', 0,
          '', '', String(err), 0, '', '', 0, 0, '', 'UNKNOWN',
        );
      } catch { /* ignore */ }
    }
  }

  logger.info(`Attachment parsing: ${totalParsed} files processed, ${totalLines} lines extracted`);
  return { parsed: totalParsed, lines: totalLines };
}
