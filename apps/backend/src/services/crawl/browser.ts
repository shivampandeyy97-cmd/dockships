import fs from 'fs';

/**
 * Headless-Chromium fallback for sites that block plain HTTP clients
 * (JS challenges, TLS-fingerprint WAFs, Akamai/Cloudflare bot management).
 *
 * Used ONLY in the "deep" retry pass for domains that failed the fast pass, with a
 * tiny page pool so it fits in a 512 MB container. The browser is launched lazily
 * and closed after a period of inactivity.
 */

export interface BrowserPage { status: number; html: string; finalUrl: string }

const MAX_PAGES = Math.max(1, Number(process.env.BROWSER_CONCURRENCY) || 2);
const IDLE_CLOSE_MS = 60_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let browserPromise: Promise<any> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let active = 0;
const waiters: Array<() => void> = [];
let disabledReason: string | null = null;

function executablePath(): string | undefined {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  return undefined; // let puppeteer use its bundled browser (local dev)
}

export function browserFallbackEnabled(): boolean {
  if (process.env.BROWSER_FALLBACK === 'off') return false;
  return disabledReason === null;
}

async function getBrowser(): Promise<any> {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath(),
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        '--no-zygote', '--no-first-run', '--disable-extensions', '--mute-audio',
        '--disable-background-networking', '--disable-default-apps', '--disable-sync',
        '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors',
        '--blink-settings=imagesEnabled=false', '--js-flags=--max-old-space-size=192',
      ],
      protocolTimeout: 45_000,
    });
    browser.on('disconnected', () => { browserPromise = null; });
    return browser;
  })();
  browserPromise.catch(err => {
    console.error('[Browser] Launch failed — disabling browser fallback:', err?.message || err);
    disabledReason = String(err?.message || err);
    browserPromise = null;
  });
  return browserPromise;
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (active > 0 || !browserPromise) return;
    const p = browserPromise;
    browserPromise = null;
    try { (await p).close(); } catch { /* ignore */ }
  }, IDLE_CLOSE_MS);
}

async function acquire() {
  if (active < MAX_PAGES) { active++; return; }
  await new Promise<void>(resolve => waiters.push(resolve));
  active++;
}

function release() {
  active--;
  const next = waiters.shift();
  if (next) next();
  else if (active === 0) scheduleIdleClose();
}

const CHALLENGE_RE = /just a moment|checking your browser|attention required|verify you are human|please wait|ddos-guard|access denied|one moment/i;

export async function fetchWithBrowser(url: string, timeoutMs = 25_000): Promise<BrowserPage | null> {
  if (!browserFallbackEnabled()) return null;
  await acquire();
  let page: any = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewport({ width: 1366, height: 860 });
    await page.evaluateOnNewDocument(() => {
      const g = globalThis as any;
      if (g.navigator) {
        Object.defineProperty(g.navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(g.navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(g.navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      }
      g.window = g.window || {};
      g.window.chrome = g.window.chrome || { runtime: {} };
    });
    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      const t = req.resourceType();
      if (t === 'image' || t === 'media' || t === 'font') req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    let status: number = response ? response.status() : 0;

    // Give JS challenges (Cloudflare "Just a moment…", DDoS-Guard, etc.) a chance to clear
    const title: string = await page.title().catch(() => '');
    if (CHALLENGE_RE.test(title) || status === 403 || status === 503) {
      try {
        await page.waitForFunction(
          (reSrc: string) => !new RegExp(reSrc, 'i').test((globalThis as any).document?.title || ''),
          { timeout: 12_000 },
          CHALLENGE_RE.source
        );
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
        status = 200;
      } catch { /* challenge didn't clear — report what we have */ }
    } else {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});
    }

    const html: string = await page.content();
    return { status: status || (html.length > 500 ? 200 : 0), html, finalUrl: page.url() };
  } catch {
    return null;
  } finally {
    if (page) page.close().catch(() => {});
    release();
  }
}
