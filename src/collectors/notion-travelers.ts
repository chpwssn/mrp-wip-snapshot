import type Database from 'better-sqlite3';
import type { Config } from '../utils/config.js';
import { isNotionConfigured } from '../utils/config.js';
import type { JoSummary } from '../analysis/types.js';
import { shortJobNo } from '../analysis/types.js';
import { logger } from '../utils/logger.js';

interface NotionTraveler {
  pageId: string;
  name: string;
  status: string;
  priority: string;
  blocker: string;
  promisedShipDate: string | null;
  buildScheduleStart: string | null;
  buildScheduleEnd: string | null;
  joNumbers: string[];
}

const JO_PATTERN = /W\d{4,5}/g;

export async function enrichWithNotion(
  config: Config,
  db: Database.Database,
  snapshotId: number,
  summaries: JoSummary[],
): Promise<void> {
  if (!isNotionConfigured(config)) {
    logger.info('Notion not configured — skipping Travelers enrichment');
    return;
  }

  logger.info('Fetching Notion Travelers...');
  const travelers = await fetchTravelers(config);
  logger.info(`Fetched ${travelers.size} travelers`);

  const updateStmt = db.prepare(`
    UPDATE jo_summary SET
      notion_page_id = ?,
      notion_status = ?,
      notion_priority = ?,
      notion_blocker = ?,
      notion_promised_ship_date = ?,
      notion_build_schedule_start = ?,
      notion_build_schedule_end = ?
    WHERE snapshot_id = ? AND fjobno = ?
  `);

  let matched = 0;
  const update = db.transaction(() => {
    for (const summary of summaries) {
      const shortJo = shortJobNo(summary.fjobno);
      const traveler = travelers.get(shortJo);
      if (!traveler) continue;

      matched++;
      (summary as any)._notionName = traveler.name;
      summary.notionPageId = traveler.pageId;
      summary.notionStatus = traveler.status;
      summary.notionPriority = traveler.priority;
      summary.notionBlocker = traveler.blocker;
      summary.notionPromisedShipDate = traveler.promisedShipDate;
      summary.notionBuildScheduleStart = traveler.buildScheduleStart;
      summary.notionBuildScheduleEnd = traveler.buildScheduleEnd;

      updateStmt.run(
        traveler.pageId, traveler.status, traveler.priority, traveler.blocker,
        traveler.promisedShipDate, traveler.buildScheduleStart, traveler.buildScheduleEnd,
        snapshotId, summary.fjobno,
      );
    }
  });

  update();
  logger.info(`Notion enrichment: ${matched}/${summaries.length} JOs matched to Travelers`);
}

async function fetchTravelers(config: Config): Promise<Map<string, NotionTraveler>> {
  const dbId = config.notionTravelersDbId;
  const map = new Map<string, NotionTraveler>();

  // Active statuses (not Cancelled or Shipped)
  const activeStatuses = [
    'Pre-Sales', 'Order Entry', 'Build Committee', 'Planning',
    'On Hold', 'Engineering', 'Follow Up',
    'Kitting', 'Production', 'Application', 'QC', 'Shipping',
  ];

  let hasMore = true;
  let startCursor: string | undefined;

  while (hasMore) {
    // The Travelers DB uses an unnamed status property ("") — fetch all and filter client-side
    const body: Record<string, unknown> = {
      page_size: 100,
    };
    if (startCursor) body.start_cursor = startCursor;

    const response = await fetch(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.notionApiKey}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Notion API ${response.status}: ${text}`);
    }

    const data = await response.json() as NotionQueryResponse;

    for (const page of data.results) {
      const traveler = parseTraveler(page);
      if (!traveler) continue;

      // Skip completed statuses
      if (traveler.status === 'Shipped' || traveler.status === 'Cancelled') continue;

      for (const joNum of traveler.joNumbers) {
        map.set(joNum, traveler);
      }
    }

    hasMore = data.has_more;
    startCursor = data.next_cursor ?? undefined;
  }

  return map;
}

function parseTraveler(page: NotionPage): NotionTraveler | null {
  const props = page.properties;
  const name = extractTitle(props.Name) || '';
  const joNumbers = [...name.matchAll(JO_PATTERN)].map(m => m[0]);

  if (joNumbers.length === 0) return null;

  return {
    pageId: page.id,
    name,
    status: props['']?.status?.name || props.Status?.status?.name || '',
    priority: props.Priority?.select?.name || '',
    blocker: extractRichText(props.Blocker) || '',
    promisedShipDate: props['Promised Ship Date']?.date?.start || null,
    buildScheduleStart: props['Build Schedule']?.date?.start || null,
    buildScheduleEnd: props['Build Schedule']?.date?.end || null,
    joNumbers,
  };
}

function extractTitle(prop: NotionProperty | undefined): string {
  if (!prop?.title) return '';
  return prop.title.map((t: { plain_text: string }) => t.plain_text).join('');
}

function extractRichText(prop: NotionProperty | undefined): string {
  if (!prop?.rich_text) return '';
  return prop.rich_text.map((t: { plain_text: string }) => t.plain_text).join('');
}

// Notion API response types (minimal)
interface NotionQueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionPage {
  id: string;
  properties: Record<string, NotionProperty>;
}

interface NotionProperty {
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  status?: { name: string };
  select?: { name: string };
  date?: { start: string; end: string | null };
  [key: string]: unknown;
}
