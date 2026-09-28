// Launches Chrome (GPU, headless) on the reel page and waits until it is ready.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { startServer } from './server.mjs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export async function openReel({ onFrame, query = 'render=1' } = {}) {
  const server = await startServer({ onFrame });
  const port = server.address().port;
  const executablePath = CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error('Chrome not found; set CHROME_PATH');
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-driver-bug-workarounds',
      '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    protocolTimeout: 600000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log('[page]', m.type(), m.text()); });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto(`http://127.0.0.1:${port}/src/index.html?${query}`);
  await page.waitForFunction('window.reelReady || window.reelError', { timeout: 120000 });
  const err = await page.evaluate('window.reelError');
  if (err) { await browser.close(); server.close(); throw new Error(err); }
  const renderer = await page.evaluate('window.reel.renderer');
  const close = async () => { await browser.close(); server.close(); };
  return { page, browser, server, renderer, close };
}
