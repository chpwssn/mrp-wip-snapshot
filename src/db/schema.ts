import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

export function ensureSchema(db: Database.Database) {
  logger.debug('Ensuring database schema');

  db.exec(`
    -- Schema version tracking (for future collector migrations)
    CREATE TABLE IF NOT EXISTS schema_version (
      collector TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Snapshot run metadata
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      jo_count INTEGER,
      bom_line_count INTEGER,
      blind_spot_count INTEGER,
      error_count INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running'
    );

    -- Per-JO rollup summary
    CREATE TABLE IF NOT EXISTS jo_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
      fjobno TEXT NOT NULL,
      fpartno TEXT,
      fpartrev TEXT,
      fdescript TEXT,
      fquantity REAL,
      fsono TEXT,
      fddue_date TEXT,
      fpriority TEXT,
      fstatus TEXT,
      fact_rel TEXT,
      fopen_dt TEXT,
      -- Computed rollup fields
      total_bom_lines INTEGER NOT NULL,
      complete_count INTEGER NOT NULL,
      on_order_count INTEGER NOT NULL,
      partial_count INTEGER NOT NULL,
      blind_spot_count INTEGER NOT NULL,
      requisitioned_count INTEGER NOT NULL,
      overissued_count INTEGER NOT NULL,
      make_count INTEGER NOT NULL,
      make_complete_count INTEGER NOT NULL DEFAULT 0,
      make_in_progress_count INTEGER NOT NULL DEFAULT 0,
      make_blocked_count INTEGER NOT NULL DEFAULT 0,
      make_no_jo_count INTEGER NOT NULL DEFAULT 0,
      phantom_count INTEGER NOT NULL DEFAULT 0,
      stock_available_count INTEGER NOT NULL DEFAULT 0,
      -- Notion traveler enrichment
      notion_page_id TEXT,
      notion_status TEXT,
      notion_priority TEXT,
      notion_blocker TEXT,
      notion_promised_ship_date TEXT,
      notion_build_schedule_start TEXT,
      notion_build_schedule_end TEXT,
      -- Jira enrichment summary
      jira_open_req_count INTEGER DEFAULT 0,
      jira_req_keys TEXT,
      UNIQUE(snapshot_id, fjobno)
    );

    -- Per-BOM-line detail
    CREATE TABLE IF NOT EXISTS bom_line_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
      fjobno TEXT NOT NULL,
      fbompart TEXT NOT NULL,
      fbomrev TEXT,
      fbomdesc TEXT,
      fbominum TEXT NOT NULL,
      fbomsource TEXT,
      fparent TEXT,
      fparentrev TEXT,
      -- Quantity analysis
      factqty REAL NOT NULL,
      fquantity REAL NOT NULL,
      extended_qty REAL NOT NULL,
      fqty_iss REAL NOT NULL,
      ftotqty REAL,
      -- PO coverage
      po_ordered_qty REAL NOT NULL DEFAULT 0,
      po_received_qty REAL NOT NULL DEFAULT 0,
      po_still_on_order REAL NOT NULL DEFAULT 0,
      po_numbers TEXT,
      -- Gap analysis
      total_supplied REAL NOT NULL,
      total_expected REAL NOT NULL,
      gap REAL NOT NULL,
      -- Status classification
      status TEXT NOT NULL,
      -- M2M metadata
      fresponse TEXT,
      fqtytopurc REAL,
      fpono TEXT,
      fpoqty REAL,
      -- PO detail JSON
      po_details_json TEXT,
      -- Inline part metadata (from inmastx)
      fgroup TEXT,                            -- M2M part group (SUPPLY = phantom/shop supply)
      fprodcl TEXT,                           -- M2M product class (SS = shop supply)
      is_phantom INTEGER DEFAULT 0,           -- 1 if fgroup=SUPPLY or fprodcl=SS
      on_hand_qty REAL DEFAULT 0,             -- total on-hand inventory (inline from inmastx.inonhd)
      on_hand_details_json TEXT,              -- JSON: on-hand by location/bin
      -- System-wide enrichment (Redbook-style context for blind spots)
      sys_po_total_open REAL DEFAULT 0,       -- total open PO qty for this part across ALL JOs/inventory
      sys_po_total_ordered REAL DEFAULT 0,    -- total ordered qty system-wide
      sys_po_total_received REAL DEFAULT 0,   -- total received qty system-wide
      sys_po_overdue_qty REAL DEFAULT 0,      -- qty on POs past due date
      sys_po_details_json TEXT,               -- JSON: all system POs for this part
      UNIQUE(snapshot_id, fjobno, fbominum)
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_bom_status ON bom_line_status(snapshot_id, status);
    CREATE INDEX IF NOT EXISTS idx_bom_jo ON bom_line_status(snapshot_id, fjobno);
    CREATE INDEX IF NOT EXISTS idx_jo_snapshot ON jo_summary(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_jo_blind_spots ON jo_summary(snapshot_id, blind_spot_count DESC);

    -- ============================================
    -- Jira Requisition Cache Tables
    -- ============================================

    -- Sync state tracking
    CREATE TABLE IF NOT EXISTS jira_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_sync_at TEXT NOT NULL,
      issues_synced INTEGER DEFAULT 0
    );

    -- Cached requisitions
    CREATE TABLE IF NOT EXISTS jira_requisitions (
      key TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      summary TEXT,
      description TEXT,
      status TEXT,
      status_category TEXT,
      reporter TEXT,
      assignee TEXT,
      priority TEXT,
      created TEXT,
      updated TEXT,
      -- Parsed/extracted references
      extracted_jo_numbers TEXT,
      extracted_so_numbers TEXT,
      extracted_part_numbers TEXT,
      -- Sync metadata
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Requisition attachments (immutable once ingested)
    CREATE TABLE IF NOT EXISTS jira_requisition_attachments (
      attachment_id TEXT PRIMARY KEY,
      issue_key TEXT NOT NULL REFERENCES jira_requisitions(key),
      filename TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      is_xlsx INTEGER NOT NULL DEFAULT 0,
      created TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- PO subtasks
    CREATE TABLE IF NOT EXISTS jira_po_subtasks (
      key TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      parent_key TEXT NOT NULL,
      summary TEXT,
      status TEXT,
      status_category TEXT,
      assignee TEXT,
      created TEXT,
      updated TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Parsed requisition line items (from XLSX attachments)
    CREATE TABLE IF NOT EXISTS jira_parsed_req_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_key TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      format TEXT NOT NULL,              -- 'requisition_form' | 'gc_ordering' | 'post_wo_kitting'
      sheet_name TEXT,
      row_number INTEGER,
      part_number TEXT,
      part_rev TEXT,
      description TEXT,
      qty REAL,
      vendor TEXT,
      vendor_part TEXT,
      vendor_qty REAL,
      unit_cost REAL,
      destination TEXT,                  -- JO number (W####), SO number, 'INV', etc.
      destination_type TEXT,             -- 'JO' | 'SO' | 'INV' | 'UNKNOWN'
      parsed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ============================================
    -- The Tool (Order Tracking spreadsheet)
    -- ============================================

    CREATE TABLE IF NOT EXISTS tool_tracking (
      fjobno TEXT PRIMARY KEY,
      company TEXT,
      country TEXT,
      so_number TEXT,
      po_number TEXT,
      system_description TEXT,
      status_raw TEXT,
      status_phase TEXT,
      kitting_notes TEXT,
      build_start TEXT,
      build_finish TEXT,
      lab_start TEXT,
      lab_finish TEXT,
      install TEXT,
      po_rec_date TEXT,
      po_confirmed_date TEXT,
      order_entry_date TEXT,
      will_ship TEXT,
      quoted_delivery TEXT,
      parts_ordered TEXT,
      last_part_due TEXT,
      gc_status TEXT,
      standards_status TEXT,
      software_status TEXT,
      computer_status TEXT,
      special_hw_status TEXT,
      total_po_value REAL,
      notes TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tool_phase ON tool_tracking(status_phase);

    -- Jira cache indexes
    CREATE INDEX IF NOT EXISTS idx_jira_req_status ON jira_requisitions(status_category);
    CREATE INDEX IF NOT EXISTS idx_jira_req_jo ON jira_requisitions(extracted_jo_numbers);
    CREATE INDEX IF NOT EXISTS idx_jira_attach_issue ON jira_requisition_attachments(issue_key);
    CREATE INDEX IF NOT EXISTS idx_jira_parsed_issue ON jira_parsed_req_lines(issue_key);
    CREATE INDEX IF NOT EXISTS idx_jira_parsed_part ON jira_parsed_req_lines(part_number);
    CREATE INDEX IF NOT EXISTS idx_jira_parsed_dest ON jira_parsed_req_lines(destination);
    CREATE INDEX IF NOT EXISTS idx_jira_po_parent ON jira_po_subtasks(parent_key);
  `);

  // Track schema version
  db.prepare(`
    INSERT OR REPLACE INTO schema_version (collector, version, applied_at)
    VALUES ('wip-shortage', 1, datetime('now'))
  `).run();

  logger.debug('Schema ensured (version 1)');
}
