// Run with: PLAYWRIGHT_PATH=/path/to/playwright/index.mjs node tests/extension.mjs
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = resolve(import.meta.dirname, '..');
const extension = process.env.EXTENSION_PATH || root;
const profile = await mkdtemp(join(tmpdir(), 'superscreenshot-test-'));
const server = createServer(async (req, res) => {
  const body = await readFile(join(root, 'examples/long-page.html'));
  res.setHeader('Content-Type', 'text/html'); res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: null,
  args: ["--window-size=1200,900", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const target = await context.newPage();
  await target.goto(`http://127.0.0.1:${server.address().port}/`);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const errors = [];
  context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.startsWith('http://127.0.0.1:')).id);
  const timings = [];
  for (const [mode, device] of [['visible', null], ['full', null], ['full', 'iphone15pro'], ['full', 'ipad']]) {
    await target.bringToFront();
    await target.evaluate(() => scrollTo(0, 100));
    await target.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const before = await target.evaluate(() => ({ y: scrollY, width: innerWidth, height: innerHeight, visibility: getComputedStyle(document.querySelector('header')).visibility }));
    const started = performance.now();
    const previewPromise = context.waitForEvent('page', { predicate: p => p.url().includes('preview.html') });
    await popup.evaluate(({tabId, mode, device}) => {
      const port = chrome.runtime.connect({name:'capture'});
      window.capturePort = port;
      window.captureErrors = [];
      port.onMessage.addListener(m => { if(m.type === 'error') window.captureErrors.push(m.error); });
      port.postMessage({ type:'CAPTURE', tabId, mode, device });
    }, {tabId, mode, device});
    const preview = await previewPromise;
    await preview.locator('#image').waitFor({state:'visible'});
    await preview.waitForFunction(() => document.querySelector('#image').naturalWidth > 0);
    const elapsed = Math.round(performance.now() - started);
    const dimensions = await preview.locator('#image').evaluate(img => ({width:img.naturalWidth,height:img.naturalHeight}));
    const dpr = device === 'iphone15pro' ? 3 : device === 'ipad' ? 2 : 1;
    const width = device === 'iphone15pro' ? 393 : device === 'ipad' ? 768 : 1200;
    assert.equal(dimensions.width, width * dpr);
    assert.equal(dimensions.height, (mode === 'full' ? 2700 : before.height) * dpr);
    if (!process.env.BASELINE) {
      assert.equal(await target.evaluate(() => getComputedStyle(document.querySelector('header')).visibility), before.visibility);
      assert.equal(await target.evaluate(() => scrollY), before.y);
      assert.equal(await target.evaluate(() => innerWidth), before.width);
    }
    // Pixel check at the final section catches blank/truncated stitching, including overlap on the last tile.
    const pixel = await preview.evaluate(() => {
      const img = document.querySelector('#image');
      const c = document.createElement('canvas'); c.width=1; c.height=1;
      const ctx=c.getContext('2d'); ctx.drawImage(img, img.naturalWidth-10, img.naturalHeight-10, 1,1,0,0,1,1);
      return Array.from(ctx.getImageData(0,0,1,1).data);
    });
    assert.deepEqual(pixel, mode === 'full' ? [220,252,231,255] : before.y + before.height - 10 >= 900 ? [219,234,254,255] : [245,245,245,255]);
    assert.deepEqual(await popup.evaluate(() => window.captureErrors), []);
    timings.push({mode,device:device||'desktop',elapsedMs:elapsed,...dimensions});
    if (process.env.ARTIFACT_DIR && mode === 'full' && !device) {
      await mkdir(process.env.ARTIFACT_DIR, {recursive:true});
      await preview.screenshot({path:join(process.env.ARTIFACT_DIR,'preview.png')});
    }
    if (!process.env.BASELINE && mode === 'visible') {
      await preview.locator('#zoom-in').click();
      assert.equal(await preview.locator('#zoom-fit').innerText(),'125%');
      await preview.locator('#zoom-fit').click();
      const downloadPromise = preview.waitForEvent('download');
      await preview.locator('#download').click();
      const download = await downloadPromise;
      assert.match(download.suggestedFilename(),/^screenshot-.*\.png$/);
      assert.equal(await download.failure(),null);
    }
    const captureId = new URL(preview.url()).searchParams.get('id');
    await preview.close();
    await popup.evaluate(async captureId => {
      const {getCapture}=await import('./store.js');
      for(let i=0;i<30;i++) { if(!await getCapture(captureId)) return; await new Promise(r=>setTimeout(r,50)); }
      throw new Error('Capture was not deleted when preview closed');
    },captureId);
    // Baseline contains the fixed-header restoration bug, so reload fixture between captures.
    await target.reload();
  }
  if (!process.env.BASELINE) {
    await target.bringToFront();
    await target.evaluate(() => scrollTo(0, 100));
    const beforeCancel = await target.evaluate(() => ({y:scrollY,width:innerWidth}));
    const pageCount = context.pages().length;
    await popup.evaluate(tabId => {
      const port=chrome.runtime.connect({name:'capture'});
      window.cancelOutcome=null;
      port.onMessage.addListener(m => {
        if(m.type==='progress' && m.phase==='capturing' && m.current===1) port.postMessage({type:'CANCEL'});
        if(['cancelled','error','done'].includes(m.type)) window.cancelOutcome=m.type;
      });
      port.postMessage({type:'CAPTURE',mode:'full',device:'iphone15pro',tabId});
    },tabId);
    await popup.waitForFunction(() => window.cancelOutcome !== null);
    assert.equal(await popup.evaluate(() => window.cancelOutcome),'cancelled');
    assert.deepEqual(await target.evaluate(() => ({y:scrollY,width:innerWidth})),beforeCancel);
    assert.equal(await target.evaluate(() => getComputedStyle(document.querySelector('header')).visibility),'visible');
    assert.equal(context.pages().length,pageCount);
    assert.deepEqual(await popup.evaluate(async () => (await import('./store.js')).listCaptureIds()),[]);
    // Check all visible UI strings and accessibility labels with Chrome's catalog contract in both locales.
    for (const locale of ['en','es']) {
      const catalog = JSON.parse(await readFile(join(root,'_locales',locale,'messages.json'),'utf8'));
      const page = await context.newPage();
      await page.addInitScript(({locale,catalog}) => {
        chrome.i18n.getUILanguage = () => locale;
        chrome.i18n.getMessage = (key, subs=[]) => catalog[key]?.message.replace(/\$(\d)/g, (_,n) => (Array.isArray(subs) ? subs : [subs])[Number(n)-1] ?? '') || '';
      },{locale,catalog});
      await page.goto(`chrome-extension://${id}/popup.html`);
      assert.equal(await page.locator('#full').innerText(), catalog.fullPage.message);
      assert.equal(await page.locator('html').getAttribute('lang'),locale);
      await page.evaluate(() => { document.querySelector('#warning').hidden=true; });
      if(process.env.ARTIFACT_DIR) await page.locator('body').screenshot({path:join(process.env.ARTIFACT_DIR,`popup-${locale}.png`)});
      await page.goto(`chrome-extension://${id}/preview.html`);
      assert.equal(await page.locator('#status').innerText(),catalog.missingId.message);
      assert.equal(await page.locator('#download').innerText(),catalog.save.message);
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({timings, checks:process.env.BASELINE ? 'baseline dimensions, final pixels and cleanup' : 'dimensions, final pixels, page and cancellation restoration, cleanup, PNG download, zoom, English/Spanish popup and preview'},null,2));
} finally {
  await context.close(); server.close(); await rm(profile,{recursive:true,force:true});
}
