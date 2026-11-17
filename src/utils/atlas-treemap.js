// Pure squarified treemap layout, heat color scale, era constants, and label helpers for Metadata Atlas.

export const SHORT_DECADE_LABELS = {
  'pre-1960s': 'Pre-60s', '1960s': '60s', '1970s': '70s', '1980s': '80s',
  '1990s': '90s', '2000s': '00s', '2010s': '10s', '2020s': '20s',
};

export const HEAT_STEPS = [3, 13, 24, 35, 45];

export const ERA_SLICE_STEPS = {
  'pre-1960s': 14, '1960s': 18, '1970s': 23, '1980s': 28,
  '1990s': 34, '2000s': 40, '2010s': 48, '2020s': 56,
};

export function metricValue(entry, metric) {
  if (!entry) return 0;
  return metric === 'spins' ? (entry.spinCount || 0) : (entry.songCount || 0);
}

export function heatMixFill(pct) {
  return `color-mix(in srgb, var(--as-accent-fg) ${pct}%, var(--as-bg-base))`;
}

export function computeHeatIntensity(val, minVal, maxVal) {
  const raw = maxVal > minVal ? (val - minVal) / (maxVal - minVal) : 0.65;
  const curved = Math.pow(Math.max(0, Math.min(1, raw)), 1.25);
  return Math.round(3 + curved * 42);
}

function worstAspect(row, side) {
  if (!row.length || side <= 0) return Infinity;
  const sum = row.reduce((acc, item) => acc + item.area, 0);
  if (sum <= 0) return Infinity;
  const maxA = Math.max(...row.map((r) => r.area));
  const minA = Math.min(...row.map((r) => r.area));
  return Math.max((side * side * maxA) / (sum * sum), (sum * sum) / (side * side * Math.max(minA, 1e-6)));
}

export function squarifyLayout(items, x, y, w, h) {
  const positive = items.filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  if (!positive.length || w <= 0 || h <= 0) return [];
  const totalVal = positive.reduce((s, d) => s + d.value, 0);
  const scaled = positive.map((item) => ({ ...item, area: (item.value / totalVal) * (w * h) }));

  const rects = [];
  let rx = x; let ry = y; let rw = w; let rh = h;
  let row = [];

  const flushRow = () => {
    if (!row.length) return;
    const sum = row.reduce((s, item) => s + item.area, 0);
    if (rw >= rh) {
      const colW = sum / Math.max(rh, 1);
      let cy = ry;
      for (const item of row) {
        const ih = item.area / Math.max(colW, 1e-6);
        rects.push({ ...item, x: rx, y: cy, w: colW, h: ih });
        cy += ih;
      }
      rx += colW;
      rw = Math.max(0, rw - colW);
    } else {
      const rowH = sum / Math.max(rw, 1);
      let cx = rx;
      for (const item of row) {
        const iw = item.area / Math.max(rowH, 1e-6);
        rects.push({ ...item, x: cx, y: ry, w: iw, h: rowH });
        cx += iw;
      }
      ry += rowH;
      rh = Math.max(0, rh - rowH);
    }
    row = [];
  };

  for (const item of scaled) {
    const side = Math.min(rw, rh);
    if (!row.length || worstAspect([...row, item], side) <= worstAspect(row, side)) row.push(item);
    else { flushRow(); row.push(item); }
  }
  flushRow();
  return rects;
}

export function collectPeakYears(decades, metric, limit = 6) {
  const rows = [];
  for (const dec of decades) {
    for (const yr of dec.years || []) {
      rows.push({
        decadeId: dec.id, decadeLabel: dec.label, year: yr.year,
        songCount: yr.songCount, spinCount: yr.spinCount, value: metricValue(yr, metric),
        topArtist: yr.topSongs?.[0]?.artist || '', topSong: yr.topSongs?.[0] || null, yearObj: yr,
      });
    }
  }
  rows.sort((a, b) => b.value - a.value || b.songCount - a.songCount || b.year - a.year);
  return rows.slice(0, limit);
}

export function summarizeCoverage(totalCatalogSongs, datedCatalogSongs) {
  if (!totalCatalogSongs || totalCatalogSongs <= 0) return null;
  const dated = Math.max(0, Math.min(totalCatalogSongs, datedCatalogSongs || 0));
  const undated = Math.max(0, totalCatalogSongs - dated);
  return {
    total: totalCatalogSongs,
    dated,
    undated,
    datedPct: ((dated / totalCatalogSongs) * 100).toFixed(1),
    undatedPct: ((undated / totalCatalogSongs) * 100).toFixed(1),
  };
}

export function truncateLabel(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}
