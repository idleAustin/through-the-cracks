// Unit tests for Express server entrypoint helpers and automated ingestion opt-in flag.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, scheduleAutomatedIngestion } from '../server/index.js';

describe('server entrypoint and auto-ingest scheduling (Ticket 08)', () => {
  const originalFlag = process.env.ENABLE_AUTO_INGEST;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.ENABLE_AUTO_INGEST;
    } else {
      process.env.ENABLE_AUTO_INGEST = originalFlag;
    }
    vi.restoreAllMocks();
  });

  it('keeps automated ingestion disabled by default when ENABLE_AUTO_INGEST is unset or false', () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    delete process.env.ENABLE_AUTO_INGEST;
    expect(scheduleAutomatedIngestion()).toBe(false);
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      '⏰ Automated scheduled ingestion is disabled (ENABLE_AUTO_INGEST=unset)',
    );

    process.env.ENABLE_AUTO_INGEST = 'false';
    expect(scheduleAutomatedIngestion()).toBe(false);
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      '⏰ Automated scheduled ingestion is disabled (ENABLE_AUTO_INGEST=false)',
    );
  });

  it('schedules automated ingestion only when ENABLE_AUTO_INGEST === "true"', () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(0);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    process.env.ENABLE_AUTO_INGEST = 'true';
    expect(scheduleAutomatedIngestion()).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('serves /api/health with project and dataset metadata', async () => {
    const app = createApp({ query: async () => [], project: 'p1', dataset: 'd1' });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.project).toBe('p1');
      expect(body.dataset).toBe('d1');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
