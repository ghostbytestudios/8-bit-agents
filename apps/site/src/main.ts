import '@fontsource/press-start-2p/400.css';
import './site.css';
import {
  detectPlatform,
  downloadsFrom,
  LATEST_RELEASE_API,
  PLATFORM_LABEL,
  PLATFORMS,
  RELEASES_URL,
  REPO_URL,
  type Downloads,
  type Platform,
} from './releases';

/** The client's mock office, built into /demo/ with ?demo (no server, page-friendly scrolling). */
const DEMO_URL = 'demo/?demo';
/** Below this width the office is too cramped inline, so it opens as its own page. */
const INLINE_DEMO_MIN_WIDTH = 900;
const RELEASE_TIMEOUT_MS = 8_000;
const FILE_KIND: Record<Platform, string> = {
  windows: 'Installer (.exe)',
  mac: 'Disk image (.dmg) · Apple Silicon and Intel',
  linux: 'AppImage · x64',
};

type ReleaseState =
  | { kind: 'ready'; downloads: Downloads }
  | { kind: 'none' }
  | { kind: 'unknown' };

const isWideScreen = () => window.matchMedia(`(min-width: ${INLINE_DEMO_MIN_WIDTH}px)`).matches;

function setUpDemo(): void {
  const stage = document.getElementById('demo');
  const frame = document.querySelector<HTMLIFrameElement>('#demo-frame');
  const start = document.querySelector<HTMLButtonElement>('#demo-start');
  if (!stage || !frame || !start) return;
  const play = () => {
    if (frame.src) return;
    frame.src = DEMO_URL;
    stage.dataset.state = 'playing';
  };
  start.addEventListener('click', () => {
    if (!isWideScreen()) {
      window.location.href = DEMO_URL;
      return;
    }
    play();
    frame.focus();
  });
  // Big screens get the office straight away; phones and data-savers choose to load it.
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (isWideScreen() && connection?.saveData !== true) play();
}

function setLink(link: HTMLAnchorElement, href: string | null): void {
  if (href) {
    link.href = href;
    link.removeAttribute('aria-disabled');
  } else {
    link.removeAttribute('href');
    link.setAttribute('aria-disabled', 'true');
  }
}

function renderDownloads(state: ReleaseState, visitor: Platform | null): void {
  for (const platform of PLATFORMS) {
    const link = document.querySelector<HTMLAnchorElement>(`[data-download="${platform}"]`);
    const note = document.querySelector<HTMLElement>(`[data-download-note="${platform}"]`);
    if (!link || !note) continue;
    if (state.kind === 'ready') {
      const href = state.downloads.links[platform] ?? null;
      setLink(link, href);
      note.textContent = href ? `${state.downloads.version} · ${FILE_KIND[platform]}` : 'Coming soon';
    } else if (state.kind === 'none') {
      setLink(link, null);
      note.textContent = 'Coming soon';
    } else {
      setLink(link, RELEASES_URL);
      note.textContent = FILE_KIND[platform];
    }
    link.closest('.download')?.classList.toggle('download--yours', platform === visitor);
  }

  const status = document.getElementById('release-status');
  if (status) {
    status.replaceChildren();
    if (state.kind === 'none') {
      const repo = Object.assign(document.createElement('a'), { href: REPO_URL, textContent: 'Watch the project on GitHub' });
      status.append('The first release is on its way. ', repo, ' to hear when it lands.');
    }
  }

  const announce = document.getElementById('announce-text');
  if (announce && state.kind === 'ready') announce.textContent = `${state.downloads.version} is out for Windows, macOS and Linux`;

  const hero = document.querySelector<HTMLAnchorElement>('#hero-download');
  if (!hero) return;
  const direct = visitor && state.kind === 'ready' ? state.downloads.links[visitor] : undefined;
  hero.textContent = visitor ? `Download for ${PLATFORM_LABEL[visitor]}` : 'Download';
  hero.href = direct ?? '#download';
}

async function latestRelease(): Promise<ReleaseState> {
  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
    });
    if (response.status === 404) return { kind: 'none' };
    if (!response.ok) return { kind: 'unknown' };
    const downloads = downloadsFrom(await response.json());
    return downloads ? { kind: 'ready', downloads } : { kind: 'unknown' };
  } catch {
    // Offline, rate-limited or blocked: plain links to the releases page still work.
    return { kind: 'unknown' };
  }
}

async function setUpDownloads(): Promise<void> {
  const visitor = detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
  renderDownloads({ kind: 'unknown' }, visitor);
  renderDownloads(await latestRelease(), visitor);
}

setUpDemo();
void setUpDownloads();
