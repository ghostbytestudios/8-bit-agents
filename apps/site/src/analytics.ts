import { analyticsCookieNames, readConsent, saveConsent, type Consent, type ConsentStore } from './consent';

const MEASUREMENT_ID = 'G-K7LF2M6VW3';
const TAG_URL = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

function browserStore(): ConsentStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let loaded = false;

/** Adds Google's tag. Only ever called after the visitor accepts. */
function loadAnalytics(): void {
  if (loaded) return;
  loaded = true;
  window.dataLayer = window.dataLayer ?? [];
  // gtag.js reads the arguments object itself, so this has to stay a plain function.
  function gtag(..._args: unknown[]): void {
    window.dataLayer?.push(arguments);
  }
  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID);
  const script = document.createElement('script');
  script.async = true;
  script.src = TAG_URL;
  document.head.append(script);
}

/** Removes the cookies Google Analytics set, on this host and its parent domains. */
function clearAnalyticsCookies(): void {
  const parts = window.location.hostname.split('.');
  const domains = ['', ...parts.map((_, i) => parts.slice(i).join('.')).filter((domain) => domain.includes('.'))];
  for (const name of analyticsCookieNames(document.cookie)) {
    for (const domain of domains) {
      const scope = domain ? `; domain=${domain}` : '';
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${scope}`;
    }
  }
}

function buildBanner(onChoose: (choice: Consent) => void): HTMLElement {
  const banner = document.createElement('section');
  banner.className = 'consent';
  banner.setAttribute('aria-labelledby', 'consent-title');

  const title = Object.assign(document.createElement('h2'), { id: 'consent-title', textContent: 'Count your visit?' });
  const text = document.createElement('p');
  const privacy = Object.assign(document.createElement('a'), { href: 'privacy.html', textContent: 'privacy page' });
  text.append(
    'With your OK, Google Analytics sets cookies so we can see how many people visit and which pages they read. Nothing is sent until you choose. More on the ',
    privacy,
    '.',
  );

  const actions = document.createElement('div');
  actions.className = 'consent__actions';
  const accept = Object.assign(document.createElement('button'), { type: 'button', className: 'button button--small', textContent: 'Accept' });
  const decline = Object.assign(document.createElement('button'), { type: 'button', className: 'button button--small', textContent: 'No thanks' });
  accept.addEventListener('click', () => onChoose('granted'));
  decline.addEventListener('click', () => onChoose('denied'));
  actions.append(accept, decline);

  banner.append(title, text, actions);
  return banner;
}

let banner: HTMLElement | null = null;

function showBanner(store: ConsentStore | null, focus: boolean): void {
  if (banner) return;
  banner = buildBanner((choice) => {
    const wasRunning = loaded;
    saveConsent(store, choice);
    banner?.remove();
    banner = null;
    if (choice === 'granted') {
      loadAnalytics();
    } else if (wasRunning) {
      // The tag is already running on this page: wipe its cookies and reload without it.
      clearAnalyticsCookies();
      window.location.reload();
    }
  });
  document.body.append(banner);
  if (focus) banner.querySelector('button')?.focus();
}

/** Starts analytics if the visitor already said yes, asks if they haven't answered, and wires "Cookie settings". */
export function setUpAnalytics(): void {
  const store = browserStore();
  const choice = readConsent(store);
  if (choice === 'granted') loadAnalytics();
  else if (choice === null) showBanner(store, false);

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-cookie-settings]')) {
    button.addEventListener('click', () => showBanner(store, true));
  }
}
