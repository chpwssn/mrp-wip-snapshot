import 'dotenv/config';

// Apply NODE_TLS_REJECT_UNAUTHORIZED from .env if set (for internal APIs with self-signed certs)
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}

export interface Config {
  m2mGraphqlUrl: string;
  dbPath: string;
  concurrency: number;
  batchDelayMs: number;
  // Optional — Jira
  jiraCloudId?: string;
  jiraEmail?: string;
  jiraApiToken?: string;
  // Optional — Notion
  notionApiKey?: string;
  notionTravelersDbId: string;
  // The Tool
  toolPath: string;
}

export function loadConfig(): Config {
  const m2mGraphqlUrl = process.env.M2M_GRAPHQL_URL;
  if (!m2mGraphqlUrl) {
    throw new Error('M2M_GRAPHQL_URL is required');
  }

  const dbPath = process.env.DB_PATH || './data/mrp.db';

  return {
    m2mGraphqlUrl,
    dbPath,
    concurrency: parseInt(process.env.CONCURRENCY || '5', 10),
    batchDelayMs: parseInt(process.env.BATCH_DELAY_MS || '200', 10),
    // Jira — all three must be set to enable
    jiraCloudId: process.env.JIRA_CLOUD_ID || undefined,
    jiraEmail: process.env.JIRA_EMAIL || undefined,
    jiraApiToken: process.env.JIRA_API_TOKEN || undefined,
    // Notion
    notionApiKey: process.env.NOTION_API_KEY || undefined,
    notionTravelersDbId: process.env.NOTION_TRAVELERS_DB_ID || '1e5d8349-4976-4ca7-bf90-db56ebb8f9b4',
    // The Tool
    toolPath: process.env.TOOL_PATH || '/Volumes/Documentation/ProductionTool/Master Document/Order Tracking MASTER NEW.xlsx',
  };
}

export function isJiraConfigured(config: Config): boolean {
  return !!(config.jiraCloudId && config.jiraEmail && config.jiraApiToken);
}

export function isNotionConfigured(config: Config): boolean {
  return !!config.notionApiKey;
}
