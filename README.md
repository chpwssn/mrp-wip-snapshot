# WIP Shortage Snapshot

Cross-references M2M, Jira Purchasing, Notion Travelers, and the Order Tracking spreadsheet to produce a shortage report for production floor walks.

## Quick Start (Docker)

```bash
# 1. Copy and fill in your API tokens
cp .env.example .env
# Edit .env with your Jira, Notion, and M2M credentials

# 2. Run a one-shot snapshot
docker compose run --rm wip-snapshot

# 3. View the report
open reports/index.html
```

## Daily Cron + Web Server

```bash
# Start Caddy (serves reports) and the daily 6 AM MT cron job
docker compose up -d caddy wip-snapshot-cron

# Reports at http://localhost:8080
# Help guide at http://localhost:8080/help.html
```

### Custom Port

```bash
WIP_PORT=3000 docker compose up -d caddy
```

### Custom Documentation Drive Path

On a server where the Documentation share is mounted elsewhere:

```bash
TOOL_VOLUME=/mnt/nas/Documentation docker compose up -d caddy wip-snapshot-cron
```

## Local Development (no Docker)

```bash
yarn install
cp .env.example .env
# Edit .env

# Run snapshot and generate HTML report
make all

# Publish to reports/ directory
make publish
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `M2M_GRAPHQL_URL` | Yes | GraphQL API endpoint for Made2Manage |
| `NODE_TLS_REJECT_UNAUTHORIZED` | — | Set to `0` for self-signed certs |
| `DB_PATH` | — | SQLite database path (default: `./data/mrp.db`) |
| `JIRA_CLOUD_ID` | No | Jira Cloud instance ID |
| `JIRA_EMAIL` | No | Jira account email |
| `JIRA_API_TOKEN` | No | Jira API token |
| `NOTION_API_KEY` | No | Notion internal integration token |
| `NOTION_TRAVELERS_DB_ID` | — | Notion Travelers database ID |
| `TOOL_PATH` | No | Path to `Order Tracking MASTER NEW.xlsx` |
| `CONCURRENCY` | — | Parallel API requests (default: 5) |
| `BATCH_DELAY_MS` | — | Delay between batches in ms (default: 200) |

Jira and Notion are optional — if tokens aren't set, those phases skip gracefully.

## Make Targets

| Command | What it does |
|---------|-------------|
| `make collect` | Run the collector, write `report.md` |
| `make html` | Convert `report.md` to `report.html` |
| `make all` | `collect` + `html` |
| `make publish` | Copy `report.html` to `reports/report_{snapshot}.html`, update `index.html` symlink |
| `make clean` | Remove `report.md` and `report.html` |

## Data Sources

| Source | What it provides |
|--------|-----------------|
| M2M (GraphQL) | BOM demand, qty issued, direct-to-JO POs, on-hand inventory, routing |
| System POs | Open POs system-wide per part (Redbook-style) |
| The Tool | Customer name, production phase, kitting notes, quoted delivery |
| Notion Travelers | Lifecycle status, blocker, priority, promised ship date |
| Jira PUR | Requisitions, parsed PDF/XLSX attachments for part-level matching |

## Version

Current: **0.1.0** — see `help.html` for the full reference guide.
