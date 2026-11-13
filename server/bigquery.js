import { BigQuery } from '@google-cloud/bigquery';

const GCP_PROJECT = process.env.GCP_PROJECT_ID || 'through-the-cracks';

let bqClient = null;

export function getBigQueryClient() {
  if (!bqClient) {
    // If a service account key string is provided in env (e.g. from Doppler), parse it
    if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
      try {
        const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
        bqClient = new BigQuery({ projectId: GCP_PROJECT, credentials });
      } catch (err) {
        console.warn('Failed to parse GCP_SERVICE_ACCOUNT_KEY JSON, falling back to default ADC:', err.message);
        bqClient = new BigQuery({ projectId: GCP_PROJECT });
      }
    } else {
      bqClient = new BigQuery({ projectId: GCP_PROJECT });
    }
  }
  return bqClient;
}

// In-memory query cache to keep BigQuery reads fast and 100% within free tier
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function queryBigQuery(sqlQuery, params = {}) {
  const cacheKey = JSON.stringify({ sqlQuery, params });
  const cached = cache.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return cached.rows;
  }

  const bq = getBigQueryClient();
  const [rows] = await bq.query({ query: sqlQuery, params });

  cache.set(cacheKey, { timestamp: Date.now(), rows });
  return rows;
}

export function clearCache() {
  cache.clear();
}
