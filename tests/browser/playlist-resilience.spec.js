// End-to-end Playwright regression specs for /playlist artist links, light-mode skeleton, invalid videoId guard, table breakpoints, and mobile touch controls.
import { expect, test } from '@playwright/test';

const YT_STUB_SCRIPT = `(() => {
  const tracker = { constructors: [], calls: [], player: null };
  window.__ytTest = tracker;
  class MockYTPlayer {
    constructor(target, opts = {}) {
      this._events = opts.events || {};
      this._videoId = opts.videoId || '';
      const iframe = document.createElement('iframe');
      iframe.src = 'about:blank';
      target?.parentNode?.replaceChild(iframe, target);
      this._iframe = iframe;
      tracker.player = this;
      tracker.constructors.push({ videoId: this._videoId, autoplay: Boolean(opts.playerVars?.autoplay) });
      setTimeout(() => this._events.onReady?.({ target: this }), 0);
    }
    getIframe() { return this._iframe; }
    cueVideoById(id) { this._videoId = id; tracker.calls.push({ method: 'cueVideoById', videoId: id }); setTimeout(() => this._events.onStateChange?.({ data: 5, target: this }), 0); }
    loadVideoById(id) { this._videoId = id; tracker.calls.push({ method: 'loadVideoById', videoId: id }); setTimeout(() => this._events.onStateChange?.({ data: 1, target: this }), 0); }
    playVideo() { tracker.calls.push({ method: 'playVideo', videoId: this._videoId }); setTimeout(() => this._events.onStateChange?.({ data: 1, target: this }), 0); }
    destroy() { tracker.calls.push({ method: 'destroy', videoId: this._videoId }); }
  }
  window.YT = { Player: MockYTPlayer, PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } };
  if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
})();`;

const makeSong = ([videoId, artist, songTitle, album, totalPlays, confidenceScore, durationSeconds]) => ({
  songKey: `${artist.toLowerCase()}|||${songTitle.toLowerCase()}`,
  artist,
  songTitle,
  album,
  totalPlays,
  videoId,
  ytTitle: songTitle,
  ytArtist: artist,
  durationSeconds,
  confidenceScore,
  matchTier: 'high',
});

const POOL = [
  ['aYdxQ05nOSo', 'The Toy Trucks', 'Schoolbus', 'Rockets, Bells And Poetry', 9, 100, 257],
  ['vid-am-01', 'Allison Moorer', 'The Rock And The Hill', 'Blood', 7, 94, 220],
  ['vid-ej-01', 'Eilen Jewell', 'Witness', 'Gypsy', 7, 100, 173],
  ['vid-ll-01', 'Los Lobos', 'Down On The Riverbed', 'The Neighborhood', 6, 100, 246],
  ['vid-rb-01', 'Randall Bramblett', 'Roll', 'The Bright Spots', 6, 100, 202],
  ['vid-ts-01', 'Todd Snider', 'Alright Guy', 'Songs for the Daily Planet', 8, 99, 212],
  ['vid-jp-01', 'John Prine', 'Sam Stone', 'John Prine', 6, 98, 255],
  ['vid-lw-01', 'Lucinda Williams', 'Car Wheels On A Gravel Road (Extended Live Archive Cut)', 'Car Wheels on a Gravel Road', 5, 97, 284],
  ['vid-bd-01', 'Bob Dylan', 'Mississippi', 'Love and Theft', 4, 95, 321],
  ['vid-gw-01', 'Gillian Welch', 'Look at Miss Ohio', 'Soul Journey', 4, 94, 256],
  ['vid-jd-01', 'Jason Isbell', 'Cover Me Up', 'Southeastern', 5, 96, 291],
  ['vid-tvz-01', 'Townes Van Zandt', 'Pancho and Lefty', 'The Late Great Townes Van Zandt', 5, 92, 218],
].map(makeSong);

async function setupResilienceBooth(page, { preinstallYt = false } = {}) {
  const errors = { console: [], page: [] };
  page.on('console', (m) => { if (m.type() === 'error') errors.console.push(m.text()); });
  page.on('pageerror', (e) => errors.page.push(e.message));
  const state = { delayMs: 0, overrideSongs: null, drawIdx: 0 };

  if (preinstallYt) await page.addInitScript(YT_STUB_SCRIPT);
  await page.route('https://www.youtube.com/iframe_api', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: YT_STUB_SCRIPT }),
  );
  await page.route('**/api/playlist/random*', async (route) => {
    const url = new URL(route.request().url());
    const count = Number(url.searchParams.get('count') || 10);
    const mode = url.searchParams.get('mode') || 'all';
    const minScore = Number(url.searchParams.get('minScore') || 85);
    const onePerArtist = url.searchParams.get('onePerArtist') !== 'false';
    if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));

    const source = state.overrideSongs || POOL;
    const songs = count === 1
      ? [source[(10 + state.drawIdx++) % source.length]]
      : source.slice(0, count);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ count: songs.length, poolSize: source.length, minScore, mode, onePerArtist, songs }),
    });
  });

  return { state, errors };
}

const expectNoErrors = (errors) => {
  expect(errors.console).toEqual([]);
  expect(errors.page).toEqual([]);
};

const BOOTH_TOUCH_SELECTORS = [
  '.booth-mode-group .seg-btn', '.booth-score-select', '.booth-artist-toggle',
  '.booth-head-actions .btn', '.booth-export-row .btn', '.booth-artist-link',
  '.booth-row-artist-btn', '.booth-dock-btn',
];

async function assertTouchControlMetrics(page, selectors, label, { checkWidth = false } = {}) {
  const result = await page.evaluate(({ sels, checkW }) => {
    const missing = [];
    const tooSmall = [];
    for (const sel of sels) {
      const els = [...document.querySelectorAll(sel)];
      if (els.length === 0) missing.push(sel);
      for (const el of els) {
        const { width, height } = el.getBoundingClientRect();
        if (height < 44 || (checkW && width < 44)) {
          tooSmall.push({ sel, text: el.textContent.trim(), width, height });
        }
      }
    }
    const select = document.querySelector('#playlist-min-score');
    return { missing, tooSmall, selectFontSize: select ? parseFloat(getComputedStyle(select).fontSize) : 0 };
  }, { sels: selectors, checkW: checkWidth });

  expect(result.missing, `missing touch selectors at ${label}`).toEqual([]);
  expect(result.tooSmall, `touch controls < 44px at ${label}`).toEqual([]);
  expect(result.selectFontSize, `#playlist-min-score fontSize at ${label}`).toBeGreaterThanOrEqual(16);
}

async function assertTooltipsHidden(page, label) {
  const counts = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.tooltip-bubble')];
    return { total: bubbles.length, shown: bubbles.filter((el) => getComputedStyle(el).display !== 'none').length };
  });
  expect(counts.total, `expected tooltips at ${label}`).toBeGreaterThan(0);
  expect(counts.shown, `non-hidden tooltips at ${label}`).toBe(0);
  await expect(page.locator('.tooltip-bubble:visible'), `visible tooltips at ${label}`).toHaveCount(0);
}

test.describe('Broadcast Booth resilience regressions', () => {
  test('desktop 1440: light skeleton contrast, clipped playlist corners, and row artist link preserving active cue slot', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop viewport spec');
    const { state, errors } = await setupResilienceBooth(page);

    await page.goto('/');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    state.delayMs = 450;
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Playlist' }).click();

    const skel = page.locator('.booth-skeleton-cockpit .skeleton').first();
    await expect(skel).toBeVisible();
    const skelStyles = await page.evaluate(() => {
      const card = document.querySelector('.booth-skeleton-cockpit .surface-region');
      const bar = document.querySelector('.booth-skeleton-cockpit .skeleton');
      return {
        theme: document.documentElement.dataset.theme,
        surfaceBg: getComputedStyle(card).backgroundColor,
        skelBg: getComputedStyle(bar).backgroundColor,
        skelBgImage: getComputedStyle(bar).backgroundImage,
      };
    });
    expect(skelStyles.theme).toBe('light');
    expect(skelStyles.surfaceBg).toBe('rgb(255, 255, 255)');
    expect(skelStyles.skelBg).toBe('rgb(234, 234, 238)');
    expect(skelStyles.skelBg).not.toBe(skelStyles.surfaceBg);
    expect(skelStyles.skelBgImage).toBe('none');

    state.delayMs = 0;
    await expect(page.locator('.booth-table tbody tr')).toHaveCount(10);
    const playlistBoxStyles = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('.booth-playlist'));
      return {
        overflow: s.overflow,
        overflowX: s.overflowX,
        overflowY: s.overflowY,
        bottomLeftRadius: s.borderBottomLeftRadius,
        bottomRightRadius: s.borderBottomRightRadius,
      };
    });
    expect(playlistBoxStyles.overflowX).toBe('hidden');
    expect(playlistBoxStyles.overflowY).toBe('hidden');
    expect(playlistBoxStyles.bottomLeftRadius).toBe('6px');
    expect(playlistBoxStyles.bottomRightRadius).toBe('6px');

    await expect(page.locator('.booth-deck .booth-region-title')).toContainText('01/10');
    await expect(page.locator('.booth-table tbody tr').nth(1)).not.toHaveClass(/is-active/);
    await page.evaluate(() => {
      window.__cueSlotChanged = false;
      const deckTitle = document.querySelector('.booth-deck .booth-region-title');
      const row1 = document.querySelectorAll('.booth-table tbody tr')[1];
      const obs = new MutationObserver(() => {
        if (!deckTitle.textContent.includes('01/10') || row1.classList.contains('is-active')) {
          window.__cueSlotChanged = true;
        }
      });
      obs.observe(deckTitle, { childList: true, subtree: true, characterData: true });
      obs.observe(row1, { attributes: true, attributeFilter: ['class'] });
    });

    await page.locator('.booth-table tbody tr').nth(1).locator('.booth-row-artist-btn').click();
    await expect(page).toHaveURL((u) => u.pathname === '/artists' && u.searchParams.get('artist') === 'Allison Moorer');
    await expect(page.getByRole('heading', { name: 'Allison Moorer', level: 2 })).toBeVisible();
    expect(await page.evaluate(() => window.__cueSlotChanged)).toBe(false);
    expect(await page.evaluate(() => window.__ytTest.calls.filter((c) => c.method === 'loadVideoById' || c.method === 'playVideo'))).toEqual([]);
    expectNoErrors(errors);
  });

  test('desktop 1440: invalid videoId renders blocked deck without YT.Player construction or watch?v= anchor', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop viewport spec');
    const { state, errors } = await setupResilienceBooth(page, { preinstallYt: true });
    state.overrideSongs = [
      { ...POOL[0], videoId: 'bad?id=1&autoplay=1' },
      { ...POOL[1], videoId: 'aYdxQ05nOSo' },
    ];

    await page.goto('/playlist');
    const blocked = page.locator('.yt-deck-blocked[role="alert"]');
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText('Video unavailable. Swap song to cue another.');
    await expect(page.locator('.booth-status-chip.is-blocked')).toHaveText('Blocked');
    await expect(blocked.locator('a[href*="watch?v="]')).toHaveCount(0);
    await expect(page.locator('a[href*="watch?v="]')).toHaveCount(0);
    await expect(page.locator('.yt-deck-host iframe')).toHaveCount(0);
    expect(await page.evaluate(() => window.__ytTest.constructors)).toEqual([]);

    await page.locator('.booth-table tbody tr').nth(1).locator('.booth-song-btn').click();
    await expect(blocked).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__ytTest.constructors.length)).toBe(1);

    await page.locator('.booth-table tbody tr').nth(0).locator('.booth-song-btn').click();
    await expect(blocked).toBeVisible();
    await expect(blocked.locator('a[href*="watch?v="]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__ytTest.constructors.length)).toBe(1);
    expect(await page.evaluate(() => window.__ytTest.calls.some((c) => c.method === 'destroy'))).toBe(true);
    expectNoErrors(errors);
  });

  test('desktop threshold viewports (769..1440): col-album breakpoints, col-num widths, and zero table overflow', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop viewport spec');
    const { errors } = await setupResilienceBooth(page);

    await page.goto('/playlist');
    await expect(page.locator('.booth-table tbody tr')).toHaveCount(10);

    const visibleAlbumWidths = new Set([1025, 1367, 1440]);
    for (const width of [769, 960, 961, 1025, 1181, 1366, 1367, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const metrics = await page.evaluate(() => {
        const wrap = document.querySelector('.booth-playlist .table-container');
        const thIssues = [...document.querySelectorAll('.booth-table thead th')]
          .filter((th) => th.scrollWidth > th.clientWidth + 1)
          .map((th) => ({ text: th.textContent.trim(), scrollW: th.scrollWidth, clientW: th.clientWidth }));
        const albumCells = [...document.querySelectorAll('.booth-table .col-album')].map((el) => ({
          display: getComputedStyle(el).display,
          width: el.getBoundingClientRect().width,
        }));
        const numHeaders = [...document.querySelectorAll('.booth-table thead th.col-num')].map((th) => ({
          text: th.textContent.trim(),
          width: th.getBoundingClientRect().width,
          scrollW: th.scrollWidth,
          clientW: th.clientWidth,
        }));
        return {
          docOverflow: document.documentElement.scrollWidth > window.innerWidth,
          wrapScrollW: wrap.scrollWidth,
          wrapClientW: wrap.clientWidth,
          thIssues,
          albumCells,
          numHeaders,
        };
      });
      expect(metrics.docOverflow, `doc overflow at ${width}px`).toBe(false);
      expect(metrics.wrapScrollW, `table wrapper overflow at ${width}px`).toBeLessThanOrEqual(metrics.wrapClientW);
      expect(metrics.thIssues, `header overflow at ${width}px`).toEqual([]);

      expect(metrics.albumCells.length, `.col-album count at ${width}px`).toBe(11);
      for (const cell of metrics.albumCells) {
        if (visibleAlbumWidths.has(width)) {
          expect(cell.display, `.col-album visible at ${width}px`).not.toBe('none');
          expect(cell.width, `.col-album width at ${width}px`).toBeGreaterThanOrEqual(90);
        } else {
          expect(cell.display, `.col-album hidden at ${width}px`).toBe('none');
        }
      }

      if (width === 769 || width === 960) {
        expect(metrics.numHeaders.map((h) => h.text)).toEqual(['Spins', 'Match']);
        for (const h of metrics.numHeaders) {
          expect(h.width, `${h.text} width at ${width}px`).toBeGreaterThanOrEqual(54);
          expect(h.scrollW, `${h.text} overflow at ${width}px`).toBeLessThanOrEqual(h.clientW + 1);
        }
      }
    }
    expectNoErrors(errors);
  });

  test('coarse-pointer > 768px (769x900, 1025x900): >=44px booth controls, >=16px select, and 0 visible tooltips', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Coarse-pointer > 768px viewport spec');
    const controlSelectors = [...BOOTH_TOUCH_SELECTORS, 'button.booth-upnext', '.booth-song-btn', '.booth-table-swap-btn'];

    for (const vp of [{ width: 769, height: 900 }, { width: 1025, height: 900 }]) {
      const context = await browser.newContext({ viewport: vp, hasTouch: true, baseURL: testInfo.project.use.baseURL, colorScheme: 'dark' });
      try {
        const touchPage = await context.newPage();
        const { errors } = await setupResilienceBooth(touchPage);
        await touchPage.goto('/playlist');
        await expect(touchPage.locator('.booth-table tbody tr')).toHaveCount(10);
        expect(await touchPage.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        expect(await touchPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await assertTouchControlMetrics(touchPage, controlSelectors, `coarse ${vp.width}x${vp.height}`);
        await touchPage.getByRole('button', { name: 'Next song' }).tap();
        await assertTooltipsHidden(touchPage, `coarse ${vp.width}x${vp.height}`);
        expectNoErrors(errors);
      } finally {
        await context.close();
      }
    }
  });

  test('mobile (320x667, 375x812, 430x932, 667x375): >=44px touch targets, >=8px mode gap, 16px select, hidden tooltips, artist routing', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-375', 'Mobile viewport spec');
    const { errors } = await setupResilienceBooth(page);
    const viewports = [{ width: 320, height: 667 }, { width: 375, height: 812 }, { width: 430, height: 932 }, { width: 667, height: 375 }];
    const controlSelectors = [...BOOTH_TOUCH_SELECTORS, '.mobile-playlist-btn', '.mobile-theme-btn', '.booth-mobile-song', '.booth-mobile-swap-btn'];

    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await page.goto('/playlist');
      await expect(page.locator('.booth-mobile-row')).toHaveCount(10);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      const modeMetrics = await page.evaluate(() => {
        const group = document.querySelector('.booth-mode-group');
        const gs = getComputedStyle(group);
        const boxes = [...group.querySelectorAll('.seg-btn')].map((el) => el.getBoundingClientRect());
        let minHorizGap = Infinity;
        for (let i = 1; i < boxes.length; i += 1) {
          if (Math.abs(boxes[i].top - boxes[i - 1].top) < 4) {
            minHorizGap = Math.min(minHorizGap, boxes[i].left - boxes[i - 1].right);
          }
        }
        return {
          colGap: parseFloat(gs.columnGap),
          rowGap: parseFloat(gs.rowGap),
          minHorizGap,
          minHeight: Math.min(...boxes.map((b) => b.height)),
        };
      });
      expect(modeMetrics.colGap).toBeGreaterThanOrEqual(8);
      expect(modeMetrics.rowGap).toBeGreaterThanOrEqual(8);
      if (Number.isFinite(modeMetrics.minHorizGap)) expect(modeMetrics.minHorizGap).toBeGreaterThanOrEqual(7.5);
      expect(modeMetrics.minHeight).toBeGreaterThanOrEqual(44);

      await assertTouchControlMetrics(page, controlSelectors, `${vp.width}x${vp.height}`, { checkWidth: true });

      await page.getByRole('button', { name: 'Next song' }).tap();
      await page.locator('.booth-artist-toggle').tap();
      await expect(page.locator('.booth-cockpit')).not.toHaveAttribute('aria-busy', 'true');
      await page.getByRole('button', { name: 'Roll 10' }).tap();
      await expect(page.locator('.booth-cockpit')).not.toHaveAttribute('aria-busy', 'true');
      await assertTooltipsHidden(page, `${vp.width}x${vp.height}`);
    }

    await page.locator('.booth-mobile-row').nth(1).locator('.booth-row-artist-btn').tap();
    await expect(page).toHaveURL((u) => u.pathname === '/artists' && u.searchParams.get('artist') === 'Allison Moorer');
    await expect(page.getByRole('heading', { name: 'Allison Moorer', level: 2 })).toBeVisible();
    expectNoErrors(errors);
  });
});
