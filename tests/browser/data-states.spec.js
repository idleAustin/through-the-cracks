// End-to-end Playwright specs for shared loading skeleton, deadpan empty/error states, and unknown-route recovery.
import { expect, test } from '@playwright/test';
import { EXPECTED } from './snapshot-expected.js';

test.describe('archive data states and unknown route recovery', () => {
  test('renders flat .skeleton loading rows while artists data is pending', async ({ page }) => {
    await page.route('**/api/artists*', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }),
    );
    await page.route('**/data/artists.json', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const response = await route.fetch();
      await route.fulfill({ response });
    });

    await page.goto('/artists');

    const skeleton = page.locator('[aria-busy="true"] .skeleton').first();
    await expect(skeleton).toBeVisible();
    const bgImage = await skeleton.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bgImage).toBe('none');

    await expect(page.locator('#artists-table:visible, .m-card-stack:visible')).toContainText('Todd Snider');
  });

  test('renders deadpan empty filter states with Clear Filter recovery on artists and songs', async ({ page }) => {
    const cases = [
      {
        path: '/artists',
        searchLabel: 'Search artists',
        query: 'zzzznoartistmatch',
        emptyHeading: 'No artists match that filter.',
        tableSelector: '#artists-table:visible, .m-card-stack:visible',
        expectedText: 'Todd Snider',
      },
      {
        path: '/songs',
        searchLabel: 'Search songs',
        query: 'zzzznosongmatch',
        emptyHeading: 'No songs match that filter.',
        tableSelector: '#songs-table:visible, .m-card-stack:visible',
        expectedText: '50s French Movie',
      },
    ];

    for (const entry of cases) {
      await page.goto(entry.path);
      const searchbox = page.getByRole('searchbox', { name: entry.searchLabel });
      await expect(page.locator(entry.tableSelector)).toContainText(entry.expectedText);

      await searchbox.fill(entry.query);
      await expect(page.getByRole('heading', { name: entry.emptyHeading })).toBeVisible();
      const clearBtn = page.getByRole('button', { name: 'Clear Filter' });
      await expect(clearBtn).toBeVisible();

      await clearBtn.click();
      await expect(searchbox).toHaveValue('');
      await expect(page.locator(entry.tableSelector)).toContainText(entry.expectedText);
    }
  });

  test('renders deadpan error state on failed episodes fetch and recovers on Retry Fetch', async ({ page }) => {
    let episodeJsonAttempts = 0;

    await page.route('**/api/episodes*', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }),
    );
    await page.route('**/data/episodes-index.json', async (route) => {
      episodeJsonAttempts += 1;
      if (episodeJsonAttempts === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
        return;
      }
      await route.continue();
    });

    await page.goto('/episodes');

    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Archive request failed.');
    const retryBtn = alert.getByRole('button', { name: 'Retry Fetch' });
    await expect(retryBtn).toBeVisible();

    await retryBtn.click();
    await expect(alert).toBeHidden();
    await expect(page.locator('main')).toContainText(EXPECTED.latestAirDateShort);
  });

  test('renders deadpan unknown route recovery and returns to Overview', async ({ page }) => {
    await page.goto('/unknown-archive-path');

    await expect(page.getByRole('heading', { name: 'Route not found.' })).toBeVisible();
    const returnLink = page.getByRole('link', { name: 'Return to Overview' });
    await expect(returnLink).toBeVisible();

    await returnLink.click();
    await expect(page).toHaveURL('/');
    await expect(page.locator('#kpi-plays')).toHaveText(EXPECTED.totalSpinsFmt);
  });

  test('passes mobile-web touch target, input font-size, tooltip, and 320px overflow checks', async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'mobile-375') return;

    await page.goto('/');
    await page.getByRole('button', { name: /Switch to (light|dark) theme/i }).tap();
    for (const bubble of await page.locator('.tooltip-bubble').all()) {
      await expect(bubble).toBeHidden();
    }

    const searchChecks = [
      { path: '/artists', inputId: '#artist-search-input', readySelector: '#artists-table:visible, .m-card-stack:visible' },
      { path: '/songs', inputId: '#song-search-input', readySelector: '#songs-table:visible, .m-card-stack:visible' },
      { path: '/search', inputId: '#global-search-input', readySelector: '#global-search-input' },
    ];
    for (const { path, inputId, readySelector } of searchChecks) {
      await page.goto(path);
      await expect(page.locator(readySelector)).toBeVisible();
      const input = page.locator(inputId);
      await expect(input).toHaveAttribute('enterkeyhint', 'search');
      const fontSize = await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(fontSize).toBeGreaterThanOrEqual(16);
    }

    await page.locator('#global-search-input').fill('Prine');
    const searchRow = page.locator('#search-artists-table tbody tr:visible, .m-card:visible').first();
    await expect(searchRow).toBeVisible();
    expect((await searchRow.boundingBox()).height).toBeGreaterThanOrEqual(44);

    const expectTouchTarget = async (locator) => {
      await expect(locator).toBeVisible();
      const box = await locator.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    };

    await page.keyboard.press('Control+k');
    await expectTouchTarget(page.locator('.cmd-close-btn'));
    await page.keyboard.press('Escape');

    await page.goto('/artists');
    await expectTouchTarget(page.locator('.btn-sm').first());
    await expectTouchTarget(page.locator('.seg-btn', { hasText: 'All' }).first());

    await page.goto('/songs');
    await expectTouchTarget(page.locator('.m-card .cell-link-btn').first());

    await page.goto('/episodes');
    const yearSelect = page.locator('.year-select');
    await expect(yearSelect).toBeVisible();
    expect((await yearSelect.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expectTouchTarget(page.locator('.m-card').first());

    await page.goto(`/episodes?episode=${EXPECTED.latestEpisodeId}`);
    await expectTouchTarget(page.locator('.playlist-mobile-main .cell-link-btn').first());
    await expectTouchTarget(page.locator('.source-post-link').first());

    await page.goto('/unknown-archive-path');
    await expectTouchTarget(page.locator('.btn').first());

    await page.setViewportSize({ width: 320, height: 640 });
    for (const [path, readySelector] of [
      ['/', '#kpi-plays'],
      ['/artists', '#artists-table:visible, .m-card-stack:visible'],
      ['/artists?artist=Todd%20Snider', '.push-view'],
      ['/songs', '#songs-table:visible, .m-card-stack:visible'],
      ['/episodes', '.m-card'],
      [`/episodes?episode=${EXPECTED.latestEpisodeId}`, '.playlist-pane'],
      ['/search', '#global-search-input'],
    ]) {
      await page.goto(path);
      await expect(page.locator(readySelector).first()).toBeVisible();
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
    }
  });
});
