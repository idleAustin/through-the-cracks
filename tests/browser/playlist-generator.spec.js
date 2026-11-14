// End-to-end Playwright specs for /playlist Broadcast Booth navigation, singleton YouTube deck, Roll 10, and responsive geometry.
import { expect, test } from '@playwright/test';

const YT_IFRAME_API_STUB = `(() => {
  const tracker = { constructors: [], calls: [] };
  window.__ytTest = tracker;

  class MockYTPlayer {
    constructor(target, options = {}) {
      this._events = options.events || {};
      this._videoId = options.videoId || '';
      const iframe = document.createElement('iframe');
      iframe.src = 'about:blank';
      iframe.dataset.videoId = this._videoId;
      if (target && target.parentNode) {
        target.parentNode.replaceChild(iframe, target);
      }
      this._iframe = iframe;
      tracker.constructors.push({
        videoId: this._videoId,
        autoplay: Boolean(options.playerVars?.autoplay),
      });
      setTimeout(() => this._events.onReady?.({ target: this }), 0);
    }
    getIframe() { return this._iframe; }
    cueVideoById(videoId) {
      this._videoId = videoId;
      this._iframe.dataset.videoId = videoId;
      tracker.calls.push({ method: 'cueVideoById', videoId });
      setTimeout(() => this._events.onStateChange?.({ data: 5, target: this }), 0);
    }
    loadVideoById(videoId) {
      this._videoId = videoId;
      this._iframe.dataset.videoId = videoId;
      tracker.calls.push({ method: 'loadVideoById', videoId });
      setTimeout(() => {
        this._events.onStateChange?.({ data: 3, target: this });
        setTimeout(() => this._events.onStateChange?.({ data: 1, target: this }), 10);
      }, 0);
    }
    playVideo() {
      tracker.calls.push({ method: 'playVideo', videoId: this._videoId });
      setTimeout(() => this._events.onStateChange?.({ data: 1, target: this }), 0);
    }
    destroy() {
      tracker.calls.push({ method: 'destroy', videoId: this._videoId });
    }
  }

  window.YT = {
    Player: MockYTPlayer,
    PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  };
  if (typeof window.onYouTubeIframeAPIReady === 'function') {
    window.onYouTubeIframeAPIReady();
  }
})();`;

function trackPageErrors(page) {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  return { consoleErrors, pageErrors };
}

async function stubYouTubeIframeApi(page) {
  await page.route('https://www.youtube.com/iframe_api', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: YT_IFRAME_API_STUB,
    });
  });
}

async function assertNoHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
}

async function assertSquare16x9Deck(page) {
  const deckMetrics = await page.evaluate(() => {
    const frame = document.querySelector('.yt-deck-frame');
    const iframe = document.querySelector('.yt-deck-host iframe');
    if (!frame || !iframe) return null;
    const frameRect = frame.getBoundingClientRect();
    const frameStyle = getComputedStyle(frame);
    const iframeStyle = getComputedStyle(iframe);
    return {
      width: frameRect.width,
      height: frameRect.height,
      frameRadius: frameStyle.borderRadius,
      iframeRadius: iframeStyle.borderRadius,
    };
  });
  expect(deckMetrics).not.toBeNull();
  expect(deckMetrics.frameRadius).toBe('0px');
  expect(deckMetrics.iframeRadius).toBe('0px');
  expect(Math.abs(deckMetrics.width / deckMetrics.height - 16 / 9)).toBeLessThan(0.05);
}

test.describe('Random Playlist Generator (/playlist Broadcast Booth)', () => {
  test('desktop: reaches /playlist via CockpitSidebar and Ctrl+K, renders equal-height 10-song booth and singleton YT deck', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop cockpit spec');
    const { consoleErrors, pageErrors } = trackPageErrors(page);
    await stubYouTubeIframeApi(page);

    await page.goto('/');
    const sidebar = page.locator('.cockpit-sidebar');
    const playlistLink = sidebar.getByRole('link', { name: 'Playlist' });
    await expect(playlistLink).toBeVisible();
    await expect(playlistLink.locator('svg')).toHaveAttribute('stroke-width', '2');

    await playlistLink.click();
    await expect(page).toHaveURL('/playlist');
    await expect(playlistLink).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Broadcast Booth', level: 1 })).toBeVisible();

    await expect(page.locator('.booth-table tbody tr')).toHaveCount(10);
    await expect(page.locator('.yt-deck-host iframe')).toBeVisible();
    await assertSquare16x9Deck(page);

    const cockpitGeometry = await page.evaluate(() => {
      const deck = document.querySelector('.booth-deck');
      const playlist = document.querySelector('.booth-playlist');
      const deckBar = deck?.querySelector('.region-toolbar');
      const playlistBar = playlist?.querySelector('.region-toolbar');
      if (!deck || !playlist || !deckBar || !playlistBar) return null;
      const dRect = deck.getBoundingClientRect();
      const pRect = playlist.getBoundingClientRect();
      const dbRect = deckBar.getBoundingClientRect();
      const pbRect = playlistBar.getBoundingClientRect();
      return {
        bottomDelta: Math.abs(dRect.bottom - pRect.bottom),
        deckToolbarHeight: Math.round(dbRect.height),
        playlistToolbarHeight: Math.round(pbRect.height),
        toolbarBottomDelta: Math.abs(dbRect.bottom - pbRect.bottom),
      };
    });
    expect(cockpitGeometry).not.toBeNull();
    expect(cockpitGeometry.bottomDelta).toBeLessThanOrEqual(1);
    expect(cockpitGeometry.deckToolbarHeight).toBe(46);
    expect(cockpitGeometry.playlistToolbarHeight).toBe(46);
    expect(cockpitGeometry.toolbarBottomDelta).toBeLessThanOrEqual(1);

    const initialSongs = await page.locator('.booth-table tbody .booth-song-btn').allTextContents();
    expect(initialSongs).toHaveLength(10);
    expect(await page.evaluate(() => window.__ytTest.constructors.length)).toBe(1);

    await page.locator('.booth-table tbody tr').nth(1).locator('.booth-song-btn').click();
    await expect(page.locator('.booth-song-title')).toHaveText(initialSongs[1]);
    await expect(page.locator('.booth-status-chip')).toContainText('Playing');

    await page.locator('.booth-table tbody tr').nth(3).locator('.booth-song-btn').click();
    await expect(page.locator('.booth-song-title')).toHaveText(initialSongs[3]);

    const afterClicks = await page.evaluate(() => window.__ytTest);
    expect(afterClicks.constructors).toHaveLength(1);
    const loadCalls = afterClicks.calls.filter((c) => c.method === 'loadVideoById');
    expect(loadCalls).toHaveLength(2);
    expect(loadCalls[0].videoId).not.toBe(loadCalls[1].videoId);

    const rollBtn = page.getByRole('button', { name: 'Roll 10' });
    await rollBtn.click();
    await expect.poll(() => page.locator('.booth-table tbody .booth-song-btn').allTextContents()).not.toEqual(initialSongs);
    await expect(rollBtn).toBeEnabled();
    await expect(page.locator('.booth-table tbody tr')).toHaveCount(10);
    expect(await page.evaluate(() => window.__ytTest.constructors.length)).toBe(1);

    // Navigate away and reach /playlist via Control+K Command Palette.
    await sidebar.getByRole('link', { name: 'Overview' }).click();
    await expect(page).toHaveURL('/');
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await palette.getByRole('button', { name: /Playlist/i }).first().click();
    await expect(page).toHaveURL('/playlist');
    await expect(page.getByRole('heading', { name: 'Broadcast Booth', level: 1 })).toBeVisible();

    await assertNoHorizontalOverflow(page);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('mobile: reaches /playlist via MobileTopBar and Ctrl+K, switches rows in singleton YT deck, and rolls fresh 10', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-375', 'Mobile viewport spec');
    const { consoleErrors, pageErrors } = trackPageErrors(page);
    await stubYouTubeIframeApi(page);

    await page.goto('/');
    const topbar = page.locator('.mobile-topbar');
    await expect(topbar).toBeVisible();
    const topbarBox = await topbar.boundingBox();
    expect(topbarBox.height).toBeGreaterThanOrEqual(50);
    expect(topbarBox.height).toBeLessThanOrEqual(56);

    const mobilePlaylistLink = topbar.getByRole('link', { name: 'Playlist' });
    await expect(mobilePlaylistLink).toBeVisible();
    const linkBox = await mobilePlaylistLink.boundingBox();
    expect(linkBox.width).toBeGreaterThanOrEqual(44);
    expect(linkBox.height).toBeGreaterThanOrEqual(44);

    await mobilePlaylistLink.click();
    await expect(page).toHaveURL('/playlist');
    await expect(mobilePlaylistLink).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Broadcast Booth', level: 1 })).toBeVisible();

    const mobileRows = page.locator('.booth-mobile-row');
    await expect(mobileRows).toHaveCount(10);
    await expect(page.locator('.yt-deck-host iframe')).toBeVisible();
    await assertSquare16x9Deck(page);

    const initialSongs = await page.locator('.booth-mobile-song').allTextContents();
    expect(initialSongs).toHaveLength(10);

    await page.locator('.booth-mobile-song').nth(1).click();
    await expect(page.locator('.booth-song-title')).toHaveText(initialSongs[1]);
    await expect(page.locator('.booth-status-chip')).toContainText('Playing');

    await page.locator('.booth-mobile-song').nth(2).click();
    await expect(page.locator('.booth-song-title')).toHaveText(initialSongs[2]);

    const ytState = await page.evaluate(() => window.__ytTest);
    expect(ytState.constructors).toHaveLength(1);
    expect(ytState.calls.filter((c) => c.method === 'loadVideoById')).toHaveLength(2);

    const rollBtn = page.getByRole('button', { name: 'Roll 10' });
    await rollBtn.click();
    await expect.poll(() => page.locator('.booth-mobile-song').allTextContents()).not.toEqual(initialSongs);
    await expect(rollBtn).toBeEnabled();
    await expect(mobileRows).toHaveCount(10);
    expect(await page.evaluate(() => window.__ytTest.constructors.length)).toBe(1);

    await page.locator('.mobile-bottom-tabs').getByRole('link', { name: 'Overview' }).click();
    await expect(page).toHaveURL('/');
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await palette.getByRole('button', { name: /Playlist/i }).first().click();
    await expect(page).toHaveURL('/playlist');
    await expect(page.getByRole('heading', { name: 'Broadcast Booth', level: 1 })).toBeVisible();

    await assertNoHorizontalOverflow(page);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('mobile 320x667: keeps MobileTopBar 50..56px, all 5 MobileBottomTabs >= 54px unclipped, and zero overflow on /playlist', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-375', 'Narrow mobile viewport spec');
    const { consoleErrors, pageErrors } = trackPageErrors(page);
    await stubYouTubeIframeApi(page);
    await page.setViewportSize({ width: 320, height: 667 });

    await page.goto('/');
    const topbarBox = await page.locator('.mobile-topbar').boundingBox();
    expect(topbarBox.height).toBeGreaterThanOrEqual(50);
    expect(topbarBox.height).toBeLessThanOrEqual(56);

    const tabMetrics = await page.evaluate(() =>
      [...document.querySelectorAll('.mobile-bottom-tabs .mobile-tab-link')].map((el) => {
        const rect = el.getBoundingClientRect();
        const label = el.querySelector('.mobile-tab-label');
        return {
          text: el.textContent?.trim() || '',
          width: rect.width,
          height: rect.height,
          clipped: label ? label.scrollWidth > label.clientWidth + 1 : false,
        };
      }),
    );
    expect(tabMetrics).toHaveLength(5);
    for (const tab of tabMetrics) {
      expect(tab.width).toBeGreaterThanOrEqual(54);
      expect(tab.height).toBeGreaterThanOrEqual(44);
      expect(tab.clipped).toBe(false);
    }

    await page.locator('.mobile-topbar').getByRole('link', { name: 'Playlist' }).click();
    await expect(page).toHaveURL('/playlist');
    await expect(page.locator('.booth-mobile-row')).toHaveCount(10);
    await assertNoHorizontalOverflow(page);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
