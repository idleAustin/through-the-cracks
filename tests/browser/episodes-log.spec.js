// End-to-end Playwright specs for Ticket 03 Episodes two-pane Broadcast Log, mobile push playlist, and song filtering.
import { expect, test } from '@playwright/test';
import { EXPECTED } from './snapshot-expected.js';

test.describe('Episodes broadcast log and song-to-broadcast filtering', () => {
  test('renders stripped Air Date + tabular Fira Code Spin counts without Episode # or blog Title', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/episodes');

    await expect(page.getByRole('heading', { name: 'Episodes', level: 1 })).toBeVisible();
    const listScope = isMobile ? page.locator('.m-card').first() : page.locator('.airdate-rail');
    await expect(listScope).toContainText(EXPECTED.latestAirDateShort);
    await expect(listScope).toContainText(`${EXPECTED.latestSongCount} spins`);

    const spinReadout = listScope.getByText(`${EXPECTED.latestSongCount} spins`).first();
    const spinStyles = await spinReadout.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontFamily: s.fontFamily, fontVariantNumeric: s.fontVariantNumeric };
    });
    expect(spinStyles.fontFamily).toMatch(/Fira Code/i);
    expect(spinStyles.fontVariantNumeric).toContain('tabular-nums');

    await expect(page.locator('main')).not.toContainText(/Episode\s*#|#\d{3,4}|Playlist for WEVL/i);
  });

  test('renders permanent two-pane Broadcast Log on desktop and Full-Screen Push Playlist on mobile', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/episodes');

    const yearSelect = page.locator('.year-select');
    await expect(yearSelect).toBeVisible();
    await expect(yearSelect.locator('option', { hasText: 'All Years' })).toHaveCount(1);

    if (!isMobile) {
      const rail = page.locator('.airdate-rail');
      await expect(rail).toBeVisible();
      const railBox = await rail.boundingBox();
      expect(railBox.width).toBeGreaterThanOrEqual(276);
      expect(railBox.width).toBeLessThanOrEqual(312);

      const playlistPane = page.locator('.broadcast-log .playlist-pane');
      await expect(playlistPane).toBeVisible();
      await expect(playlistPane).toContainText(EXPECTED.latestAirDateShort);
      await expect(playlistPane).toContainText(EXPECTED.latestFirstTrack.position);
      await expect(playlistPane).toContainText(EXPECTED.latestFirstTrack.songTitle);
      await expect(playlistPane).toContainText(EXPECTED.latestFirstTrack.album);
      await expect(playlistPane.getByRole('link', { name: /Source post/i })).toHaveAttribute('href', /http/);

      await yearSelect.selectOption('2025');
      await expect(page).toHaveURL(/year=2025/);
      await expect(rail).toContainText('2025');
      await expect(playlistPane).toContainText('2025');
      await expect(playlistPane).not.toContainText(/Episode\s*#|Playlist for WEVL/i);

      await yearSelect.selectOption('');
      await page.getByRole('button', { name: /Next/i }).click();
      await expect(page).toHaveURL(/page=2/);

      await page.goto('/episodes');
      await playlistPane.getByRole('button', { name: EXPECTED.latestFirstTrack.artist }).first().click();
      await expect.poll(() => {
        const u = new URL(page.url());
        return [u.pathname, u.searchParams.get('artist')];
      }).toEqual(['/artists', EXPECTED.latestFirstTrack.artist]);
      return;
    }

    const selectBox = await yearSelect.boundingBox();
    expect(selectBox.height).toBeGreaterThanOrEqual(44);
    const selectFontSize = await yearSelect.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(selectFontSize).toBeGreaterThanOrEqual(16);

    const firstCard = page.locator('.m-card').first();
    await expect(firstCard).toBeVisible();
    expect((await firstCard.boundingBox()).height).toBeGreaterThanOrEqual(44);

    await yearSelect.selectOption('2025');
    await expect(page).toHaveURL(/year=2025/);
    await expect(page.locator('.m-card').first()).toContainText('2025');

    await page.locator('.m-card').first().click();
    await expect(page).toHaveURL(/episode=/);
    const backBtn = page.getByRole('button', { name: 'Back', exact: true });
    await expect(backBtn).toBeVisible();
    expect((await backBtn.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('main')).toContainText('01');

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);

    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/episode=/);
    await expect(page).toHaveURL(/year=2025/);
  });

  test('supports direct /episodes?song=&artist= filtering, playlist song clicks, and .is-song-match highlight', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    const { songTitle, artist } = EXPECTED.latestFirstTrack;
    await page.goto(`/episodes?song=${encodeURIComponent(songTitle)}&artist=${encodeURIComponent(artist)}`);

    await expect(page.getByText('Played Song')).toBeVisible();
    await expect(page.locator('.filter-banner')).toContainText(songTitle);
    const clearBtn = page.getByRole('button', { name: 'Clear Song Filter' });
    await expect(clearBtn).toBeVisible();

    if (isMobile) {
      await page.locator('.m-card').first().click();
    }

    const matchedRow = page.locator('.is-song-match').first();
    await expect(matchedRow).toBeVisible();
    await expect(matchedRow).toContainText(songTitle);

    if (isMobile) {
      await page.getByRole('button', { name: 'Back', exact: true }).click();
    }

    await clearBtn.click();
    await expect(page).not.toHaveURL(/song=/);
    await expect(page.getByText('Played Song')).toBeHidden();

    if (!isMobile) {
      await page.locator('.broadcast-log .playlist-pane').getByRole('button', { name: songTitle }).first().click();
      await expect.poll(() => {
        const u = new URL(page.url());
        return [u.searchParams.get('song'), u.searchParams.get('artist')];
      }).toEqual([songTitle, artist]);
      await expect(page.getByText('Played Song')).toBeVisible();
      await expect(page.locator('.is-song-match').first()).toBeVisible();
    }
  });
});
