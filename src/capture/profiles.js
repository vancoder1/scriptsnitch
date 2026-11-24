// Desktop and mobile visitors (design §7 "Profiles"). User agent, client hints, navigator.platform
// and touch points always agree with each other; "HeadlessChrome" never appears.

export const VIEWPORTS = {
  desktop: [[1366, 768], [1440, 900], [1536, 864], [1920, 1080]],
  mobile: [[390, 844], [393, 873], [412, 915], [360, 800]],
};

const DESKTOP_OS = {
  win32: { ua: 'Windows NT 10.0; Win64; x64', platform: 'Win32', hint: 'Windows', version: '15.0.0', architecture: 'x86' },
  darwin: { ua: 'Macintosh; Intel Mac OS X 10_15_7', platform: 'MacIntel', hint: 'macOS', version: '14.0.0', architecture: 'arm' },
  linux: { ua: 'X11; Linux x86_64', platform: 'Linux x86_64', hint: 'Linux', version: '6.5.0', architecture: 'x86' },
};

export function profileFor(name, { chromeVersion, platform = process.platform, random = Math.random }) {
  const full = /\/(\d+(?:\.\d+)*)/.exec(chromeVersion)?.[1] ?? '157.0.0.0';
  const major = full.split('.')[0];
  const brands = [{ brand: 'Google Chrome', version: major }, { brand: 'Chromium', version: major }, { brand: 'Not-A.Brand', version: '24' }];
  const fullVersionList = [{ brand: 'Google Chrome', version: full }, { brand: 'Chromium', version: full }, { brand: 'Not-A.Brand', version: '24.0.0.0' }];
  const sizes = VIEWPORTS[name];
  const [width, height] = sizes[Math.min(sizes.length - 1, Math.floor(random() * sizes.length))];
  if (name === 'mobile') {
    return {
      name,
      userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
      platform: 'Linux armv81',
      userAgentMetadata: { brands, fullVersionList, platform: 'Android', platformVersion: '14.0.0', architecture: '', model: 'Pixel 8', mobile: true, bitness: '' },
      viewport: { width, height },
      mobile: true,
      hasTouch: true,
      maxTouchPoints: 5,
      deviceScaleFactor: 2.625,
    };
  }
  const os = DESKTOP_OS[platform] ?? DESKTOP_OS.linux;
  return {
    name,
    userAgent: `Mozilla/5.0 (${os.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    platform: os.platform,
    userAgentMetadata: { brands, fullVersionList, platform: os.hint, platformVersion: os.version, architecture: os.architecture, model: '', mobile: false, bitness: '64' },
    viewport: { width, height },
    mobile: false,
    hasTouch: false,
    maxTouchPoints: 0,
    deviceScaleFactor: 1,
  };
}

export async function applyProfile(ctx, sessionId, profile, { frame = false } = {}) {
  const send = (method, params) => ctx.send(method, params, sessionId).catch(() => {});
  await send('Emulation.setUserAgentOverride', { userAgent: profile.userAgent, platform: profile.platform, userAgentMetadata: profile.userAgentMetadata });
  if (frame) return;
  await send('Emulation.setDeviceMetricsOverride', { width: profile.viewport.width, height: profile.viewport.height, deviceScaleFactor: profile.deviceScaleFactor, mobile: profile.mobile });
  await send('Emulation.setTouchEmulationEnabled', profile.hasTouch ? { enabled: true, maxTouchPoints: profile.maxTouchPoints } : { enabled: false });
}
