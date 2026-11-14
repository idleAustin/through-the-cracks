// Express HTTP server entrypoint wiring static assets, read-only API routes, and ingestion scheduling.
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, realpathSync } from 'fs';
import { queryBigQuery, clearCache } from './bigquery.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createOverviewRouter } from './routes/overview.js';
import { createEpisodesRouter } from './routes/episodes.js';
import { createCatalogRouter } from './routes/catalog.js';
import { createArtistProfileRouter } from './routes/artistProfile.js';

const execAsync = promisify(exec);
const PORT = process.env.PORT || 3001;
const GCP_PROJECT = process.env.GCP_PROJECT_ID || 'through-the-cracks';
const BQ_DATASET = process.env.BQ_DATASET || 'through_the_cracks';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

async function runIngestion(incremental = true) {
  const mode = incremental ? '--incremental' : '';
  const command = `node scripts/ingest.js ${mode}`.trim();
  console.log(`🔄 Starting automated background ingestion (${incremental ? 'incremental' : 'full'})...`);
  clearCache();

  try {
    const { stdout, stderr } = await execAsync(command);
    if (stdout) console.log(`[Ingest]: ${stdout.trim()}`);
    if (stderr) console.warn(`[Ingest Warn]: ${stderr.trim()}`);
    console.log('✅ Ingestion completed successfully.');
  } catch (err) {
    console.error(`❌ Ingestion error: ${err.message}`);
  }
}

export function scheduleAutomatedIngestion() {
  const ENABLED = process.env.ENABLE_AUTO_INGEST === 'true';
  if (!ENABLED) {
    const flagValue = process.env.ENABLE_AUTO_INGEST ?? 'unset';
    console.log(`⏰ Automated scheduled ingestion is disabled (ENABLE_AUTO_INGEST=${flagValue})`);
    return false;
  }

  const INTERVAL_HOURS = parseInt(process.env.AUTO_INGEST_HOURS) || 6;
  const INTERVAL_MS = INTERVAL_HOURS * 60 * 60 * 1000;

  const now = new Date();
  const nextRun = new Date(now);
  const currentHour = now.getUTCHours();
  const nextHour = Math.ceil((currentHour + 1) / INTERVAL_HOURS) * INTERVAL_HOURS;

  nextRun.setUTCHours(nextHour % 24, 0, 0, 0);
  if (nextHour >= 24) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }

  const delayUntilFirstRun = nextRun.getTime() - now.getTime();
  const minutes = Math.round(delayUntilFirstRun / 60000);

  console.log(`⏰ Automated ingestion scheduled every ${INTERVAL_HOURS} hours (00:00, 06:00, 12:00, 18:00 UTC).`);
  console.log(`   First scheduled run in ~${minutes} min at ${nextRun.toISOString()}`);

  setTimeout(() => {
    runIngestion(true);
    setInterval(() => {
      runIngestion(true);
    }, INTERVAL_MS);
  }, delayUntilFirstRun);
  return true;
}

export function createApp({
  query = queryBigQuery,
  project = GCP_PROJECT,
  dataset = BQ_DATASET,
} = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Rewrite /through-the-cracks/api to /api
  app.use((req, _res, next) => {
    if (req.url.startsWith('/through-the-cracks/api')) {
      req.url = req.url.replace('/through-the-cracks/api', '/api');
    }
    next();
  });

  // Serve static assets from dist and public/data
  if (existsSync(DIST_DIR)) {
    app.use('/through-the-cracks', express.static(DIST_DIR));
    app.use(express.static(DIST_DIR));
  }
  if (existsSync(PUBLIC_DIR)) {
    app.use('/through-the-cracks/data', express.static(path.join(PUBLIC_DIR, 'data')));
    app.use('/data', express.static(path.join(PUBLIC_DIR, 'data')));
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      project,
      dataset,
      timestamp: new Date().toISOString()
    });
  });

  app.use('/api', createOverviewRouter({ query, project, dataset }));
  app.use('/api', createEpisodesRouter({ query, project, dataset }));
  app.use('/api', createCatalogRouter({ query, project, dataset }));
  app.use('/api', createArtistProfileRouter({ query, project, dataset }));

  app.post('/api/ingest', async (req, res) => {
    try {
      const incremental = req.body?.incremental !== false;
      runIngestion(incremental);
      res.json({ message: 'Ingestion task started in background', mode: incremental ? 'incremental' : 'full' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // SPA Fallback: serve index.html for non-API GET requests
  if (existsSync(DIST_DIR)) {
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  // JSON error handler so malformed route params or middleware errors never leak HTML stack traces
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const isBadRequest = err instanceof URIError || err?.status === 400;
    if (!isBadRequest) console.error('Express error:', err);
    return res.status(isBadRequest ? 400 : 500).json({
      error: isBadRequest ? 'Invalid request' : 'Internal server error',
    });
  });

  return app;
}

export const app = createApp();
export default app;

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

if (isDirectExecution()) {
  app.listen(PORT, () => {
    console.log(`🚀 Express Backend API running at http://localhost:${PORT}`);
    console.log(`📊 Connected to BigQuery: ${GCP_PROJECT}.${BQ_DATASET}`);
    scheduleAutomatedIngestion();
  });
}
