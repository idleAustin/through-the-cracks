// Shared API base URL resolution and live/static archive mode telemetry emitter.
import { getStaticPath } from './api-static.js';

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
