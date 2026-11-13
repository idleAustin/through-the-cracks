// End-to-end Playwright specs for Ticket 03 Episodes two-pane Broadcast Log, mobile push playlist, and song filtering.
import { expect, test } from '@playwright/test';

test.describe('Episodes broadcast log and song-to-broadcast filtering', () => {
  test('renders stripped Air Date + tabular Fira Code Spin counts without Episode # or blog Title', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/episodes');

    await expect(page.getByRole('heading', { name: 'Episodes', level: 1 })).toBeVisible();
    const listScope = isMobile ? page.locator('.m-card').first() : page.locator('.airdate-rail');
    await expect(listScope).toContainText('Aug 8, 2026');
    await expect(listScope).toContainText('27 spins');

    const spinReadout = listScope.getByText('27 spins').first();
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
      await expect(playlistPane).toContainText('Aug 8, 2026');
      await expect(playlistPane).toContainText('01');
      await expect(playlistPane).toContainText('Prairie Girl');
      await expect(playlistPane).toContainText('The Law & The Lonesome');
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
      await playlistPane.getByRole('button', { name: 'Jonathan Byrd' }).first().click();
      await expect(page).toHaveURL(/\/artists\?artist=Jonathan(%20|\+)Byrd/);
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
    const backBtn = page.getByRole('button', { name: /Back/i });
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
    await page.goto('/episodes?song=Prairie%20Girl&artist=Jonathan%20Byrd');

    await expect(page.getByText('Played Song')).toBeVisible();
    await expect(page.locator('.filter-banner')).toContainText('Prairie Girl');
    const clearBtn = page.getByRole('button', { name: 'Clear Song Filter' });
    await expect(clearBtn).toBeVisible();

    if (isMobile) {
      await page.locator('.m-card').first().click();
    }

    const matchedRow = page.locator('.is-song-match').first();
    await expect(matchedRow).toBeVisible();
    await expect(matchedRow).toContainText('Prairie Girl');

    if (isMobile) {
      await page.getByRole('button', { name: /Back/i }).click();
    }

    await clearBtn.click();
    await expect(page).not.toHaveURL(/song=/);
    await expect(page.getByText('Played Song')).toBeHidden();

    if (!isMobile) {
      await page.locator('.broadcast-log .playlist-pane').getByRole('button', { name: 'Prairie Girl' }).first().click();
      await expect(page).toHaveURL(/song=Prairie(%20|\+)Girl/);
      await expect(page).toHaveURL(/artist=Jonathan(%20|\+)Byrd/);
      await expect(page.getByText('Played Song')).toBeVisible();
      await expect(page.locator('.is-song-match').first()).toBeVisible();
    }
  });
});
