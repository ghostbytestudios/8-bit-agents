export type Platform = 'windows' | 'mac' | 'linux';

export const PLATFORMS: readonly Platform[] = ['windows', 'mac', 'linux'];
export const PLATFORM_LABEL: Record<Platform, string> = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };

const REPO = 'ghostbytestudios/8-bit-agents';
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Installer names are fixed (apps/desktop/electron-builder.yml), so each OS has one stable link. */
export const ASSET_NAMES: Record<Platform, string> = {
  windows: '8Bit-Agents-Setup.exe',
  mac: '8Bit-Agents-mac.dmg',
  linux: '8Bit-Agents-linux.AppImage',
};
/** Only files from this repo's releases are ever linked, whatever the API returns. */
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

export interface Downloads {
  version: string;
  pageUrl: string;
  links: Partial<Record<Platform, string>>;
}

/** The visitor's desktop OS, or null on phones, tablets and anything unrecognised. */
export function detectPlatform(userAgent: string, maxTouchPoints = 0): Platform | null {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return null;
  if (/Windows/i.test(userAgent)) return 'windows';
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  if (/Macintosh|Mac OS X/i.test(userAgent)) return maxTouchPoints > 1 ? null : 'mac';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** GitHub's "latest release" JSON → links per OS; null when it isn't a usable release. */
export function downloadsFrom(json: unknown): Downloads | null {
  if (!isRecord(json) || typeof json.tag_name !== 'string' || !Array.isArray(json.assets)) return null;
  const pageUrl = typeof json.html_url === 'string' && json.html_url.startsWith(`${RELEASES_URL}/`) ? json.html_url : RELEASES_URL;
  const links: Partial<Record<Platform, string>> = {};
  for (const asset of json.assets) {
    if (!isRecord(asset) || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') continue;
    const platform = PLATFORMS.find((candidate) => ASSET_NAMES[candidate] === asset.name);
    if (platform && asset.browser_download_url.startsWith(DOWNLOAD_PREFIX)) links[platform] = asset.browser_download_url;
  }
  return { version: json.tag_name.slice(0, 32), pageUrl, links };
}
