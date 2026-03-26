import { logger } from '../utils/logger.js';

export class GraphQLClient {
  constructor(private url: string) {}

  async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify({ query, variables });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        if (!response.ok) {
          const text = await response.text();
          if (response.status >= 500 && attempt === 0) {
            logger.warn(`GraphQL 5xx (attempt ${attempt + 1}), retrying in 2s...`);
            await sleep(2000);
            continue;
          }
          throw new Error(`GraphQL HTTP ${response.status}: ${text}`);
        }

        const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };

        if (json.errors?.length) {
          const msgs = json.errors.map(e => e.message).join('; ');
          throw new Error(`GraphQL errors: ${msgs}`);
        }

        if (!json.data) {
          throw new Error('GraphQL response missing data');
        }

        return json.data;
      } catch (err) {
        if (attempt === 0 && err instanceof TypeError) {
          // Network error — retry once
          logger.warn(`GraphQL network error (attempt ${attempt + 1}), retrying in 2s...`);
          await sleep(2000);
          continue;
        }
        throw err;
      }
    }

    throw new Error('GraphQL request failed after retries');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
