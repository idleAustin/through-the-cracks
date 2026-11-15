// Shared static JSON fetch helpers, API base URL resolution, and live/static archive mode telemetry emitter.

export function getStaticPath(relativePath, baseUrl = import.meta.env.BASE_URL) {
  const base = baseUrl || '/';
  const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return base.endsWith('/') ? `${base}${cleanPath}` : `${base}/${cleanPath}`;
}

export async function fetchStaticJson(relativePath) {
  const fullStaticPath = getStaticPath(relativePath);
  const response = await fetch(fullStaticPath);
  if (!response.ok) {
    throw new Error(`Failed to load data from ${fullStaticPath} (${response.status})`);
  }
  return response.json();
}

export async function fetchStaticJsonAllow404(relativePath) {
  const fullStaticPath = getStaticPath(relativePath);
  const response = await fetch(fullStaticPath);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to load data from ${fullStaticPath} (${response.status})`);
  }
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
    return null;
  }
  if (typeof response.text !== 'function') return response.json();
  const trimmed = (await response.text()).trim();
  if (!trimmed || trimmed.startsWith('<')) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    if (!contentType.includes('json')) return null;
    throw err;
  }
}

export function resolveApiBase({
  explicitApiUrl = import.meta.env.VITE_API_URL,
  isDev = import.meta.env.DEV,
  baseUrl = import.meta.env.BASE_URL,
} = {}) {
  if (explicitApiUrl) return String(explicitApiUrl).replace(/\/+$/, '');
  if (isDev) return 'http://localhost:3001/api';
  return getStaticPath('api', baseUrl);
}

let currentMode = null;
const archiveModeListeners = new Set();

export function setArchiveMode(nextMode) {
  if (nextMode === currentMode) return;
  currentMode = nextMode;
  for (const listener of archiveModeListeners) {
    listener(nextMode);
  }
}

export function getArchiveMode() {
  return currentMode ?? 'static';
}

export function subscribeArchiveMode(listener) {
  archiveModeListeners.add(listener);
  return () => {
    archiveModeListeners.delete(listener);
  };
}
