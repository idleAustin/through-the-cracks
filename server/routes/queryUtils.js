// Shared HTTP query parameter parsing and BigQuery result value normalization helpers.

export function parsePageParams(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

export function unwrapBqValue(value) {
  return value?.value ?? value;
}

export function escapeSqlString(value) {
  return value.replace(/'/g, "''");
}
