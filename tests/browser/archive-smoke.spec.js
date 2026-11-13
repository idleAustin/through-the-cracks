// End-to-end Playwright smoke checks for archive views and --as-* token loading at 1440x900 and 375x812.
import { expect, test } from '@playwright/test';

test.describe('archive baseline & token contract smoke', () => {
  test('loads immutable thread-level-midnight --as-* tokens alongside existing theme', async ({ page }) => {
    await page.goto('/');

    const darkTokens = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return {
        bgBase: styles.getPropertyValue('--as-bg-base').trim(),
        accentPrimary: styles.getPropertyValue('--as-accent-primary').trim(),
        accentFg: styles.getPropertyValue('--as-accent-fg').trim(),
      };
    });
    expect(darkTokens).toEqual({
      bgBase: '#0a0a0c',
      accentPrimary: '#84cc16',
      accentFg: '#84cc16',
    });

    const lightTokens = await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      const styles = getComputedStyle(document.documentElement);
      return {
        bgBase: styles.getPropertyValue('--as-bg-base').trim(),
        accentFg: styles.getPropertyValue('--as-accent-fg').trim(),
      };
    });
    expect(lightTokens).toEqual({
      bgBase: '#f4f4f6',
      accentFg: '#3f6212',
    });

    const restoredDark = await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      const styles = getComputedStyle(document.documentElement);
      return {
        bgBase: styles.getPropertyValue('--as-bg-base').trim(),
        accentFg: styles.getPropertyValue('--as-accent-fg').trim(),
      };
    });
    expect(restoredDark).toEqual({
      bgBase: '#0a0a0c',
      accentFg: '#84cc16',
    });
  });

  test('preserves archive behavior across Overview, Artists, Songs, Episodes, and Search', async ({ page }) => {
    await page.goto('/');

    // Overview KPI totals and in-place artist scoping (no modal dialog)
    await expect(page.locator('#kpi-episodes')).toHaveText('1,317');
    await expect(page.locator('#kpi-plays')).toHaveText('36,902');
    await expect(page.locator('#kpi-artists')).toHaveText('1,891');
    await expect(page.locator('#kpi-songs')).toHaveText('16,782');

    const topArtistRow = page.locator('table tbody tr, .m-card-stack .m-card').filter({ hasText: 'Todd Snider' }).first();
    await expect(topArtistRow).toBeVisible();
    await topArtistRow.click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('main')).toContainText(/Annual Spins.*Todd Snider/i);
    await expect(page.getByRole('heading', { name: /Songs · Todd Snider/i })).toBeVisible();

    // Artists view + search
    const primaryNav = page.getByRole('navigation', { name: 'Primary navigation' });
    await primaryNav.getByRole('link', { name: 'Artists' }).click();
    await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible();
    await expect(page.locator('#artists-table:visible, .m-card-stack:visible')).toContainText('Todd Snider');
    await page.getByRole('searchbox', { name: 'Search artists' }).fill('Lucinda');
    await expect(page.locator('#artists-table:visible, .m-card-stack:visible')).toContainText('Lucinda Williams');

    // Songs view + search
    await primaryNav.getByRole('link', { name: 'Songs' }).click();
    await expect(page.getByRole('heading', { name: 'Songs', level: 1 })).toBeVisible();
    await expect(page.locator('#songs-table:visible, .m-card-stack:visible')).toContainText('50s French Movie');
    await page.getByRole('searchbox', { name: 'Search songs' }).fill('Hobo Lady');
    await expect(page.locator('#songs-table:visible, .m-card-stack:visible')).toContainText('McKendree Spring');

    // Episodes view + playlist selection
    await primaryNav.getByRole('link', { name: 'Episodes' }).click();
    await expect(page.getByRole('heading', { name: 'Episodes', level: 1 })).toBeVisible();
    await expect(page.locator('main')).toContainText('Aug 8, 2026');
    await page.locator('.airdate-item, .m-card').first().click();
    await expect(page.locator('main')).toContainText('Jonathan Byrd');
    await page.keyboard.press('Escape');

    // Search view
    await primaryNav.getByRole('link', { name: 'Search' }).click();
    await expect(page.getByRole('heading', { name: 'Catalog Search', level: 1 })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search the catalog' }).fill('Prine');
    await expect(page.locator('#search-artists-table:visible, .m-card-stack:visible').first()).toContainText('John Prine');
  });
});
