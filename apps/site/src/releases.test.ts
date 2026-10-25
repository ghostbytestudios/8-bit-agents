import { describe, expect, it } from 'vitest';
import { detectPlatform, downloadsFrom } from './releases';

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

const DOWNLOAD = 'https://github.com/ghostbytestudios/8-bit-agents/releases/download/v0.1.0';

describe('detectPlatform', () => {
  it('recognises the three desktop systems', () => {
    expect(detectPlatform(WINDOWS)).toBe('windows');
    expect(detectPlatform(MAC)).toBe('mac');
    expect(detectPlatform(LINUX)).toBe('linux');
  });

  it('offers no installer to phones and iPads', () => {
    expect(detectPlatform(ANDROID)).toBeNull();
    expect(detectPlatform(IPHONE)).toBeNull();
    // iPadOS sends a Mac user agent but has a touch screen.
    expect(detectPlatform(MAC, 5)).toBeNull();
  });
});

describe('downloadsFrom', () => {
  it('maps the installers in a release to their systems', () => {
    const release = {
      tag_name: 'v0.1.0',
      html_url: 'https://github.com/ghostbytestudios/8-bit-agents/releases/tag/v0.1.0',
      assets: [
        { name: '8Bit-Agents-Setup.exe', browser_download_url: `${DOWNLOAD}/8Bit-Agents-Setup.exe` },
        { name: '8Bit-Agents-mac.dmg', browser_download_url: `${DOWNLOAD}/8Bit-Agents-mac.dmg` },
        { name: 'latest.yml', browser_download_url: `${DOWNLOAD}/latest.yml` },
      ],
    };
    expect(downloadsFrom(release)).toEqual({
      version: 'v0.1.0',
      pageUrl: release.html_url,
      links: { windows: `${DOWNLOAD}/8Bit-Agents-Setup.exe`, mac: `${DOWNLOAD}/8Bit-Agents-mac.dmg` },
    });
  });

  it('never links outside this repo’s releases', () => {
    const release = {
      tag_name: 'v0.1.0',
      html_url: 'https://evil.example/release',
      assets: [{ name: '8Bit-Agents-Setup.exe', browser_download_url: 'https://evil.example/8Bit-Agents-Setup.exe' }],
    };
    expect(downloadsFrom(release)).toEqual({
      version: 'v0.1.0',
      pageUrl: 'https://github.com/ghostbytestudios/8-bit-agents/releases',
      links: {},
    });
  });

  it('rejects anything that is not a release', () => {
    expect(downloadsFrom({ message: 'Not Found' })).toBeNull();
    expect(downloadsFrom(null)).toBeNull();
  });
});
