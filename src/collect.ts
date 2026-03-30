import { loadConfig, isJiraConfigured, isNotionConfigured } from './utils/config.js';
import { setLogLevel, logger } from './utils/logger.js';
import { getDb, closeDb } from './db/connection.js';
import { collectM2mShortages } from './collectors/m2m-shortage.js';
import type { JoSummary } from './analysis/types.js';
import { enrichWithNotion } from './collectors/notion-travelers.js';
import { enrichBlindSpotsWithSystemData } from './collectors/system-enrichment.js';
import { collectToolTracking, enrichWithToolTracking } from './collectors/tool-tracking.js';
import { enrichWithJira } from './collectors/jira-requisitions.js';
import { printConsoleReport } from './report/console.js';
import { generateMarkdownReport } from './report/markdown.js';
import { analyzeDemandSupplyGaps, type DemandSupplyGap } from './analysis/demand-supply.js';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

interface CliArgs {
  verbose: boolean;
  skipJira: boolean;
  skipNotion: boolean;
  output?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  return {
    verbose: args.includes('--verbose') || args.includes('-v'),
    skipJira: args.includes('--skip-jira'),
    skipNotion: args.includes('--skip-notion'),
    output: args.find(a => a.startsWith('--output='))?.split('=')[1]
      || (args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined),
  };
}

async function main() {
  const cliArgs = parseArgs();

  if (cliArgs.verbose) {
    setLogLevel('debug');
  }

  const config = loadConfig();
  const db = getDb(config.dbPath);

  // Create snapshot
  const startedAt = new Date().toISOString();
  const { lastInsertRowid: snapshotId } = db.prepare(
    'INSERT INTO snapshots (started_at, status) VALUES (?, ?)',
  ).run(startedAt, 'running');

  logger.info(`Snapshot #${snapshotId} started`);

  try {
    // Phase 1: M2M collection (always runs)
    const summaries = await collectM2mShortages(config, db, Number(snapshotId));

    // Phase 1.5: System-wide PO and inventory enrichment for blind spots
    const ijoSummaries: JoSummary[] = (summaries as any).__ijoSummaries ?? [];
    await enrichBlindSpotsWithSystemData(config, db, Number(snapshotId), summaries);
    await enrichBlindSpotsWithSystemData(config, db, Number(snapshotId), ijoSummaries);

    // Phase 1.6: The Tool (Order Tracking spreadsheet)
    const toolData = collectToolTracking(db, config);
    enrichWithToolTracking(db, Number(snapshotId), summaries, toolData);

    // Phase 2: Notion enrichment
    if (!cliArgs.skipNotion && isNotionConfigured(config)) {
      await enrichWithNotion(config, db, Number(snapshotId), summaries);
    } else if (!isNotionConfigured(config)) {
      logger.info('Notion API key not set — skipping (use MCP interactively for enrichment)');
    } else {
      logger.info('Notion enrichment skipped (--skip-notion)');
    }

    // Phase 3: Jira requisition cache + matching
    if (!cliArgs.skipJira && isJiraConfigured(config)) {
      await enrichWithJira(config, db, Number(snapshotId), summaries);
    } else if (!isJiraConfigured(config)) {
      logger.info('Jira tokens not set — skipping (use MCP interactively for enrichment)');
    } else {
      logger.info('Jira enrichment skipped (--skip-jira)');
    }

    // Finalize snapshot
    const totalBomLines = summaries.reduce((s, j) => s + j.totalBomLines, 0);
    const totalBlindSpots = summaries.reduce((s, j) => s + j.blindSpotCount, 0);

    db.prepare(`
      UPDATE snapshots SET
        completed_at = datetime('now'),
        jo_count = ?,
        bom_line_count = ?,
        blind_spot_count = ?,
        status = 'completed'
      WHERE id = ?
    `).run(summaries.length, totalBomLines, totalBlindSpots, snapshotId);

    // Demand vs supply analysis
    const demandGaps = analyzeDemandSupplyGaps(db, Number(snapshotId));

    // Generate report
    printConsoleReport(summaries, Number(snapshotId));

    if (cliArgs.output) {
      mkdirSync(dirname(cliArgs.output), { recursive: true });
      const md = generateMarkdownReport(summaries, Number(snapshotId), demandGaps);
      writeFileSync(cliArgs.output, md, 'utf-8');
      logger.info(`Markdown report written to ${cliArgs.output}`);
    }


    logger.info(`Snapshot #${snapshotId} completed: ${summaries.length} JOs, ${totalBomLines} BOM lines, ${totalBlindSpots} blind spots`);
  } catch (err) {
    db.prepare("UPDATE snapshots SET status = 'failed', completed_at = datetime('now') WHERE id = ?")
      .run(snapshotId);
    logger.error('Snapshot failed:', err);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

main();
