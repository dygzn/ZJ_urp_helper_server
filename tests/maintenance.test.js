// NODE_PATH=<Playwright 所在的 node_modules> node --test tests/maintenance.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const root = path.resolve(__dirname, '..');

async function withPage(t, options = {}, extraScenes = []) {
    const server = http.createServer(async (req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname !== '/maintenance.html' && !/^\/maintenance-scenes\/[a-z0-9-]+\.html$/.test(pathname)) {
            res.writeHead(404).end();
            return;
        }
        try {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (pathname === '/maintenance-scenes/test-ocean.html') {
                res.end('<!doctype html><html lang="zh-CN"><title>海边日落</title><body style="background:#bed4e0">海边景观测试</body></html>');
                return;
            }
            let content = await fs.readFile(path.join(root, pathname), 'utf8');
            if (pathname === '/maintenance.html' && extraScenes.length) {
                content = content.replace(/(<script id="landscape-catalog"[^>]*>)([\s\S]*?)(<\/script>)/,
                    (_, open, json, close) => open + JSON.stringify([...JSON.parse(json), ...extraScenes]) + close);
            }
            res.end(content);
        } catch {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<html><head><title>404 Not Found</title></head><body>404 Not Found</body></html>');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
        args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    });
    t.after(() => browser.close());
    const page = await browser.newPage(options);
    return { page, url: `http://127.0.0.1:${server.address().port}/maintenance.html` };
}

test('景观载入、视角、天气和暂停由维护页控制，暂停后停止绘制', { skip: !chromium }, async t => {
    const { page, url } = await withPage(t, { viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => document.body.dataset.sceneState === 'ready', null, { timeout: 60000 });
    const scene = page.frames().find(frame => frame.url().includes('/maintenance-scenes/'));
    assert.ok(scene, '景观必须单独从维护目录加载');
    await page.getByRole('button', { name: '寺庙小径', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '寺庙小径', exact: true }).getAttribute('aria-pressed'), 'true');
    await scene.waitForFunction(() => window.valleyState.view === 2 && !window.valleyState.transitioning);
    await page.getByRole('button', { name: '雨中', exact: true }).click();
    await scene.waitForFunction(() => window.valleyState.weather === 'rain' && !window.valleyState.weatherTransitioning);
    await page.getByRole('button', { name: '暂停动画' }).click();
    await scene.waitForFunction(() => window.valleyState.paused);
    const count = await scene.evaluate(() => window.valleyState.frames);
    await page.waitForTimeout(500);
    assert.equal(await scene.evaluate(() => window.valleyState.frames), count);
    await page.getByRole('button', { name: '河畔低机位', exact: true }).click();
    await scene.waitForFunction(() => window.valleyState.view === 1);
    await page.getByRole('button', { name: '播放动画' }).click();
    await scene.waitForFunction(() => !window.valleyState.paused && window.valleyState.frames > 0);
    // 同一 iframe 在换景观时复用 WindowProxy；旧加载的迟到消息必须无效。
    await scene.evaluate(() => parent.postMessage({ type: 'landscape:error', instance: 'previous-load' }, location.origin));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.body.dataset.sceneState), 'ready');
    assert.deepEqual(errors, []);
});

test('新增独立HTML可切换，缺失景观的Nginx式404不能伪装成加载成功', { skip: !chromium }, async t => {
    const { page, url } = await withPage(t, {}, [
        { id: 'missing', name: '缺失的景观', file: 'missing.html', controls: false },
        { id: 'test-ocean', name: '海边日落', file: 'test-ocean.html', controls: false }
    ]);
    await page.goto(url);
    await page.getByLabel('选择景观').selectOption('missing');
    await page.waitForFunction(() => document.body.dataset.sceneState === 'error', null, { timeout: 10000, polling: 100 });
    assert.equal(await page.getByRole('button', { name: '刷新页面' }).isVisible(), true);
    await page.getByLabel('选择景观').selectOption('test-ocean');
    await page.waitForFunction(() => document.body.dataset.sceneState === 'ready');
    assert.equal(await page.getByLabel('选择视角').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: '暂停动画' }).isVisible(), false);
    const scene = page.frames().find(frame => frame.url().includes('/test-ocean.html'));
    assert.equal(await scene.title(), '海边日落');
});

test('手机减少动态效果时首屏能重试，景观默认静止且控件不溢出', { skip: !chromium }, async t => {
    const { page, url } = await withPage(t, { viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
    await page.goto(url);
    await page.waitForFunction(() => document.body.dataset.sceneState === 'ready', null, { timeout: 60000 });
    const scene = page.frames().find(frame => frame.url().includes('/maintenance-scenes/'));
    assert.equal(await scene.evaluate(() => window.valleyState.paused), true);
    assert.equal(await page.getByRole('button', { name: '播放动画' }).isDisabled(), true);
    const box = await page.getByRole('button', { name: '刷新页面' }).boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height < 812);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: '清晨', exact: true }).click();
    await scene.waitForFunction(() => window.valleyState.weather === 'morning');
});

test('景观文件加载失败和禁用脚本均不影响维护说明与刷新入口', { skip: !chromium }, async t => {
    const { page, url } = await withPage(t);
    await page.route('**/maintenance-scenes/**', route => route.abort());
    await page.goto(url);
    await page.waitForFunction(() => document.body.dataset.sceneState === 'error');
    assert.equal(await page.getByRole('button', { name: '刷新页面' }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '山谷全景', exact: true }).isDisabled(), true);
    const noScriptPage = await page.context().browser().newPage({ javaScriptEnabled: false });
    await noScriptPage.goto(url);
    assert.equal(await noScriptPage.getByRole('heading', { level: 1 }).isVisible(), true);
    assert.equal(await noScriptPage.getByRole('button', { name: '刷新页面' }).isVisible(), true);
    assert.equal(await noScriptPage.locator('#scene-note').isVisible(), false, '脚本禁用时不应一直显示载入中');
});

test('后台打开时不触发景观超时，回到前台继续初始化', { skip: !chromium }, async t => {
    const { page, url } = await withPage(t);
    await page.addInitScript(() => {
        window.backgroundTest = true;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.backgroundTest });
    });
    await page.goto(url);
    await page.waitForTimeout(19000);
    assert.equal(await page.evaluate(() => document.body.dataset.sceneState), 'loading');
    for (const frame of page.frames()) {
        await frame.evaluate(() => {
            window.backgroundTest = false;
            document.dispatchEvent(new Event('visibilitychange'));
        });
    }
    await page.waitForFunction(() => document.body.dataset.sceneState === 'ready', null, { timeout: 60000 });
});

test('直接双击维护HTML时从相邻目录加载景观并可切换天气', { skip: !chromium }, async t => {
    const { page } = await withPage(t);
    await page.goto(pathToFileURL(path.join(root, 'maintenance.html')).href);
    await page.waitForFunction(() => document.body.dataset.sceneState === 'ready', null, { timeout: 12000 });
    const scene = page.frames().find(frame => frame.url().includes('/maintenance-scenes/'));
    assert.ok(scene);
    await page.getByRole('button', { name: '雨中', exact: true }).click();
    await scene.waitForFunction(() => window.valleyState.weather === 'rain');
});

test('服务通知可独立隐藏、恢复，关闭后焦点回到通知按钮', { skip: !chromium }, async t => {
    const { page, url } = await withPage(t, { viewport: { width: 375, height: 812 } });
    await page.goto(url);
    const notice = page.getByRole('button', { name: '服务通知', exact: true });
    await notice.click({ timeout: 3000 });
    assert.equal(await page.getByRole('heading', { name: '教务助手正在维护' }).isVisible(), false);
    assert.equal(await notice.getAttribute('aria-expanded'), 'false');
    await notice.click();
    assert.equal(await page.getByRole('button', { name: '刷新页面' }).isVisible(), true);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await notice.evaluate(button => document.activeElement === button), true);
    await notice.click();
    assert.equal(await notice.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('参考原景观的H隐藏界面，在景观内也能恢复通知与控制栏', { skip: !chromium }, async t => {
    const { page, url } = await withPage(t);
    await page.goto(url);
    await page.waitForFunction(() => document.body.dataset.sceneState === 'ready', null, { timeout: 60000 });
    const scene = page.frames().find(frame => frame.url().includes('/maintenance-scenes/'));
    await scene.locator('canvas').click();
    await page.keyboard.press('h');
    await page.getByRole('button', { name: '显示界面', exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await page.getByRole('button', { name: '服务通知', exact: true }).isVisible(), false);
    await page.getByRole('button', { name: '显示界面', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '刷新页面' }).isVisible(), true);
    await page.getByRole('button', { name: '隐藏界面', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: '服务通知', exact: true }).isVisible(), true);
});
