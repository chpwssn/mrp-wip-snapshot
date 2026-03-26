import { logger } from '../utils/logger.js';

export class JiraClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(cloudId: string, email: string, apiToken: string) {
    this.baseUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
    this.authHeader = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
  }

  async searchJql(
    jql: string,
    options: { fields?: string[]; maxResults?: number; nextPageToken?: string } = {},
  ): Promise<JiraSearchResponse> {
    const { fields = ['summary', 'status', 'created'], maxResults = 50, nextPageToken } = options;

    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      fields: fields.join(','),
    });
    if (nextPageToken) params.set('nextPageToken', nextPageToken);

    const response = await fetch(`${this.baseUrl}/search/jql?${params}`, {
      headers: {
        Authorization: this.authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jira API ${response.status}: ${text}`);
    }

    return response.json() as Promise<JiraSearchResponse>;
  }

  async downloadAttachment(attachmentId: string): Promise<Buffer> {
    const response = await fetch(
      `${this.baseUrl}/attachment/content/${attachmentId}`,
      {
        headers: { Authorization: this.authHeader },
        redirect: 'follow',
      },
    );

    if (!response.ok) {
      throw new Error(`Jira attachment download ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async getIssue(issueKey: string, fields?: string[]): Promise<JiraIssue> {
    const params = fields ? `?fields=${fields.join(',')}` : '';
    const response = await fetch(`${this.baseUrl}/issue/${issueKey}${params}`, {
      headers: { Authorization: this.authHeader },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jira API ${response.status}: ${text}`);
    }

    return response.json() as Promise<JiraIssue>;
  }
}

// Minimal Jira types
export interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
  startAt: number;
  nextPageToken?: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: string;
    status?: { name: string; statusCategory?: { key: string; name: string } };
    issuetype?: { name: string; subtask: boolean };
    priority?: { name: string };
    reporter?: { displayName: string };
    assignee?: { displayName: string };
    created?: string;
    updated?: string;
    parent?: { key: string; fields?: { summary?: string } };
    attachment?: JiraAttachment[];
    subtasks?: Array<{ key: string; fields: { summary: string; status: { name: string; statusCategory?: { key: string; name: string } }; issuetype: { name: string } } }>;
  };
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  created: string;
}
