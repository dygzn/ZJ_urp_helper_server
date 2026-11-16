// Offline H5 checks: no school requests, no real report or credentials.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const web = path.resolve(__dirname, '..');
const html = execFileSync(path.join(web, '.venv/bin/python'), ['-c', `
from flask import Flask, render_template
app = Flask(__name__, template_folder='${web}/templates')
with app.test_request_context():
    print(render_template('wechat_lab_upload.html'))
`], { encoding: 'utf8' });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const out = '/private/tmp/urp-wechat-lab-preview';
  fs.mkdirSync(out, { recursive: true });
  try {
    for (const [width, scheme, result] of [[390, 'light', 'ok'], [320, 'dark', 'unknown'], [1000, 'light', 'validation']]) {
      const ctx = await browser.newContext({ viewport: { width, height: 850 }, colorScheme: scheme });
      let uploads = 0;
      const errors = [];
      const page = await ctx.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await ctx.route('**/*', async route => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        assert.ok(!req.url().includes('secret-ticket'), 'ticket must never appear in a network URL');
        if (pathname === '/wechat/lab/local-upload') return route.fulfill({ contentType: 'text/html', body: html });
        if (pathname.startsWith('/static/')) return route.fulfill({ path: web + pathname });
        if (pathname === '/api/wechat/lab/local-ticket-info') {
          assert.equal(req.headers().authorization, 'LabUpload secret-ticket');
          return route.fulfill({ json: { success: true, data: { title: '物理实验与误差分析（长课程名）', kind_label: '实验报告', semester: '2026-2027-1-1' } } });
        }
        if (pathname === '/api/wechat/lab/local-upload') {
          uploads++;
          assert.equal(req.headers().authorization, 'LabUpload secret-ticket');
          const body = req.postDataBuffer().toString();
          assert.ok(body.includes('实验报告.pdf'));
          assert.ok(!body.includes('item_id') && !body.includes('task_key'));
          if (result === 'unknown') return route.abort('failed');
          if (result === 'validation') return route.fulfill({ status: 400, json: { success: false, retryable: true, message: 'PDF 文件校验失败' } });
          return route.fulfill({ json: { success: true, data: { confirmed: false, message: '文件已发送，请返回核对提交状态。' } } });
        }
        if (req.url().startsWith('https://res.wx.qq.com/')) return route.fulfill({ contentType: 'application/javascript', body: '' });
        throw Error('unexpected URL ' + req.url());
      });
      await page.goto('https://example.test/wechat/lab/local-upload#ticket=secret-ticket');
      await page.waitForFunction(() => !document.getElementById('pdf').disabled);
      assert.equal(new URL(page.url()).hash, '');
      assert.ok(await page.locator('#submit').isDisabled());
      await page.locator('#pdf').setInputFiles({ name: 'too-big.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
      assert.ok(await page.locator('#submit').isDisabled());
      await page.locator('#pdf').setInputFiles({ name: '实验报告.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n') });
      assert.equal(uploads, 0, 'selection must not start uploading');
      await page.locator('#submit').click();
      await page.waitForFunction(() => document.getElementById('submit').textContent !== '正在上传…');
      assert.equal(uploads, 1);
      assert.ok(await page.locator('#submit').isDisabled());
      if (result === 'validation') assert.ok(await page.locator('#pdf').isEnabled());
      else assert.ok(await page.locator('#pdf').isDisabled());
      if (result === 'unknown') assert.match(await page.locator('#message').textContent(), /勿重复提交/);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `${width}px must not overflow`);
      await page.screenshot({ path: `${out}/${width}-${scheme}-${result}.png`, fullPage: true });
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    console.log('H5: explicit submit, 20MB validation, scoped Authorization, no token URLs, uncertain-result lock, validation recovery, 320/390/1000px light/dark passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
