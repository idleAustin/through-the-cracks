// Shared HTTP query parameter parsing and BigQuery result value normalization helpers.

const VALID_CAPS = new Set(['10', '25', '50', '100']);

export function parsePageParams(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

export function parseSortParam(sort) {
  return sort === 'obscure' ? 'obscure' : 'top';
}

export function parseCapParam(cap) {
  if (cap === undefined || cap === null) return null;
  const raw = String(cap).trim();
  return VALID_CAPS.has(raw) ? Number(raw) : null;
}

export function computeCappedPagination({ rawTotal, cap, page, limit }) {
  const total = cap ? Math.min(rawTotal, cap) : rawTotal;
  const offset = (page - 1) * limit;
  const effectiveLimit = Math.max(0, Math.min(limit, total - offset));
  const totalPages = total === 0 ? 0 : Math.max(1, Math.ceil(total / limit));
  return { total, effectiveLimit, offset, totalPages };
}

export function unwrapBqValue(value) {
  return value?.value ?? value;
}

export function escapeSqlString(value) {
  return value.replace(/'/g, "''");
}
