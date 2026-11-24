// Locates Chrome: the chrome-path input if given, else the places GitHub's runner images and
// ordinary installs put it.
import { existsSync } from 'node:fs';

export class ChromeNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChromeNotFoundError';
  }
}

export const KNOWN_PATHS = {
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
};

export function findChrome({ chromePath, platform = process.platform, exists = existsSync } = {}) {
  if (chromePath) {
    if (!exists(chromePath)) throw new ChromeNotFoundError(`chrome-path ${chromePath} does not exist`);
    return chromePath;
  }
  return (KNOWN_PATHS[platform] ?? KNOWN_PATHS.linux).find((p) => exists(p)) ?? null;
}
