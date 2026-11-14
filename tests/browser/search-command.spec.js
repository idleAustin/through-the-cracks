// End-to-end Playwright specs for Ticket 06: /search catalog workspace, Command Palette (Ctrl/Cmd+K), and layered Escape priority.
import { expect, test } from '@playwright/test';

test.describe('Search workspace and global Command Palette (⌘K / Ctrl+K)', () => {
  test('renders /search with ?q= sync, empty/zero recovery, grouped Artists & Songs/Albums, and inspector/episode routing', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/search');

    await expect(page.getByRole('heading', { name: 'Catalog Search', level: 1 })).toBeVisible();
    const input = page.locator('#global-search-input');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('enterkeyhint', 'search');

    const metrics = await input.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      fontSize: getComputedStyle(el).fontSize,
    }));
    expect(metrics.height).toBeGreaterThanOrEqual(44);
    expect(metrics.fontSize).toBe('16px');

    await expect(page.locator('main')).toContainText(/Search across|Enter at least 2 characters/i);
    await expect(page.locator('#search-artists-section, #search-songs-section')).toHaveCount(0);

    await input.fill('zzzznomatch');
    await expect(page).toHaveURL(/q=zzzznomatch/);
    await expect(page.getByRole('heading', { name: 'No archive entries match that filter.' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear Filter' }).click();
    await expect(page).not.toHaveURL(/[?&]q=/);
    await expect(input).toHaveValue('');

    await input.fill('French Movie');
    await expect(page).toHaveURL(/q=French(%20|\+)Movie/);
    const clearBtn = page.getByRole('button', { name: /Clear( search)?$/i });
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();
    await expect(input).toHaveValue('');
    await expect(page).not.toHaveURL(/[?&]q=/);

    await input.fill('French Movie');
    const main = page.locator('main');
    await expect(main).toContainText('Songs & Albums');
    await expect(main).toContainText('50s French Movie');
    await expect(main).toContainText('Carrie Rodriguez');
    if (!isMobile) {
      await expect(main).toContainText('Song');
      await expect(main).toContainText('Album');
      await expect(main).toContainText('Spins');
    }

    await main.getByText('50s French Movie').first().click();
    await expect(page).toHaveURL(/\/episodes\?.*song=50s.*artist=Carrie/);

    await page.goto('/search?q=Todd%20Snider');
    await expect(main).toContainText('Artists');
    await expect(main).toContainText('Todd Snider');

    if (isMobile) {
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
    }

    await main.getByText('Todd Snider').first().click();
    await expect(page).toHaveURL(/[?&]artist=Todd(\+|%20)Snider/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.inline-inspector, .push-view')).toHaveCount(0);

    const dashboard = main.getByLabel('Todd Snider dashboard');
    await expect(dashboard).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Todd Snider', level: 1 })).toBeVisible();
    await expect(dashboard).toContainText(/#1\s*of 1,917 artists by spins/);
    await expect(page.getByRole('button', { name: 'Back to results' })).toBeVisible();
    if (!isMobile) {
      const box = await dashboard.boundingBox();
      expect(box.width).toBeGreaterThan(440);
    }
  });

  test('opens Command Palette via Quick jump or Ctrl/Cmd+K, traps focus, and navigates quick links, themes, and grouped search', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/');

    if (!isMobile) {
      const quickJump = page.getByRole('button', { name: /Quick jump/i });
      await quickJump.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog.locator('input')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(quickJump).toBeFocused();
    }

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();
    await expect(palette).toHaveAttribute('aria-modal', 'true');

    const paletteInput = palette.locator('input');
    await expect(paletteInput).toBeFocused();

    for (const label of ['Overview', 'Artists', 'Songs', 'Episodes', 'Search', 'Latest Broadcast', 'Theme: System', 'Theme: Dark', 'Theme: Light']) {
      await expect(palette).toContainText(label);
    }

    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);

    await paletteInput.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(page).toHaveURL('/artists');

    await page.keyboard.press('Meta+k');
    await expect(palette).toBeVisible();
    await palette.getByText('Theme: Light').first().click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await page.evaluate(() => localStorage.removeItem('as-theme'));

    await page.keyboard.press('Control+k');
    await palette.locator('input').fill('Snider');
    await expect(palette).toContainText('Artists');
    await expect(palette).toContainText('Songs');
    await expect(palette).toContainText('Albums');
    await expect(palette).toContainText('Todd Snider');
    await expect(palette).toContainText('Live: Return Of The Storyteller');

    await palette.getByText('Live: Return Of The Storyteller').first().click();
    await expect(palette).toHaveCount(0);
    await expect(page).toHaveURL(/\/artists\?.*artist=Todd.*album=Live/);

    await page.keyboard.press('Control+k');
    await palette.locator('input').fill('French Movie');
    await expect(palette).toContainText('50s French Movie');
    await palette.getByText('50s French Movie').first().click();
    await expect(palette).toHaveCount(0);
    await expect(page).toHaveURL(/\/episodes\?.*song=50s.*artist=Carrie/);
  });

  test('prioritizes Escape to dismiss Command Palette before ArtistInspector and leaves 1-5 keys unbound', async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile-375';
    await page.goto('/artists?artist=Todd%20Snider');

    const inspector = isMobile ? page.locator('.push-view') : page.locator('.inline-inspector');
    await expect(inspector).toBeVisible();

    if (!isMobile) {
      await page.getByRole('button', { name: /Quick jump/i }).click();
    } else {
      await page.keyboard.press('Control+k');
    }

    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(inspector).toBeVisible();
    await expect(page).toHaveURL(/artist=Todd/);

    await page.keyboard.press('Escape');
    await expect(inspector).toBeHidden();
    await expect(page).not.toHaveURL(/artist=/);

    await page.getByRole('heading', { name: 'Artists', level: 1 }).click();
    for (const key of ['1', '2', '3', '4', '5']) {
      await page.keyboard.press(key);
      await expect(page).toHaveURL('/artists');
    }
  });
});
