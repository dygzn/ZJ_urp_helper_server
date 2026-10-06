// Test the rendered cascade and color contrast, not just stylesheet source text.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/css-architecture-preview');
const html = name => fs.readFileSync(path.join(root, 'templates', name), 'utf8')
    .replace(/{%[\s\S]*?%}/g, '').replace(/{{[\s\S]*?}}/g, '');
const courses = Array.from({ length: 12 }, (_, index) => ({
    '课程名': `对比度验证课程${index}`, '星期': index % 5 + 1,
    '节次': index % 8 + 1, '节数': 1, '位置': '教学楼 A201',
}));
const exam = { course: '对比度验证考试', exam_name: '期末考试', week: '1', day: '4',
    time: '08:20-09:05', location: '教学楼 B201' };
function luminance(rgb) {
    const channels = rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}
const contrast = (a, b) => {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
};
const color = value => value.match(/[\d.]+/g).slice(0, 3).map(Number)
    .map(c => value.startsWith('color(srgb ') ? c * 255 : c);

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        for (const theme of ['workspace', 'glass']) {
            const context = await browser.newContext({ colorScheme: 'light' });
            await context.addInitScript(theme => {
                localStorage.setItem('urp_ui_template', theme);
                localStorage.setItem('current_page', 'schedule');
            }, theme);
            await context.route('**/*', route => {
                const pathname = new URL(route.request().url()).pathname;
                if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html('index.html') });
                if (pathname === '/admin') return route.fulfill({ contentType: 'text/html', body: html('admin.html') });
                if (pathname === '/ad') return route.fulfill({ contentType: 'text/html', body: html('ad_detail.html') });
                if (pathname.startsWith('/static/')) return route.fulfill({ path: root + pathname });
                const data = { success: true, bound: true, logged_in: true, username: 'css-test', announcements: [],
                    event: { current: null, upcoming: [] }, exams: [exam], semester_start: '2026-09-28' };
                if (pathname === '/api/schedule') data.data = { schedule: { 1: courses }, exams: [exam], semester_start: '2026-09-28' };
                return route.fulfill({ json: data });
            });
            const page = await context.newPage();
            await page.goto('http://urp.test/');
            await page.locator('.is-current .course-card').first().waitFor();
            const structure = await page.evaluate(() => {
                const violations = [];
                const inspectTheme = rules => {
                    for (const rule of rules) {
                        if (rule.cssRules) inspectTheme(rule.cssRules);
                        else if (rule.style) for (const property of rule.style) {
                            if (!property.startsWith('--') || rule.style.getPropertyPriority(property)) violations.push(`${rule.selectorText}: ${property}`);
                        }
                    }
                };
                for (const sheet of document.styleSheets) {
                    if (!sheet.href) continue;
                    for (const rule of sheet.cssRules) {
                        if (!rule.constructor.name.startsWith('CSSLayer')) violations.push(`${sheet.href}: unlayered ${rule.constructor.name}`);
                    }
                    if (/\/(taste-theme|liquid-glass)\.css/.test(sheet.href)) inspectTheme(sheet.cssRules);
                }
                return violations;
            });
            assert.deepEqual(structure, []);
            const lowerLayer = await page.addStyleTag({ content: '@layer base { html.urp-root[data-ui-template] { --ui-ink: #ff00ff; } }' });
            assert.notEqual(await page.locator('body').evaluate(el => getComputedStyle(el).color), 'rgb(255, 0, 255)', 'theme tokens beat a more specific base selector');
            await lowerLayer.evaluate(el => el.remove());
            for (const width of [1440, 390]) {
                await page.setViewportSize({ width, height: 900 });
                await page.emulateMedia({ colorScheme: 'light' });
                await page.waitForTimeout(150);
                const geometry = await page.locator('.is-current .schedule-grid').boundingBox();
                await page.emulateMedia({ colorScheme: 'dark' });
                await page.waitForTimeout(80);
                const bodyColor = await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor);
                assert.equal(bodyColor, 'rgb(15, 23, 42)', `${theme} follows system dark canvas`);
                assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#0f172a');
                const darkGeometry = await page.locator('.is-current .schedule-grid').boundingBox();
                assert.ok(Math.abs(geometry.width - darkGeometry.width) < 1 && Math.abs(geometry.height - darkGeometry.height) < 1,
                    JSON.stringify({ theme, width, geometry, darkGeometry }));
                const painted = await page.locator('.is-current .course-card').evaluateAll(elements => elements.map(el => ({
                    marker: getComputedStyle(el, '::before').backgroundColor,
                    ink: getComputedStyle(el).color,
                })));
                for (const item of painted) {
                    assert.ok(contrast(color(item.marker), [51, 65, 85]) >= 4.5, `${theme} course/exam marker ${item.marker}`);
                    assert.ok(contrast(color(item.ink), [51, 65, 85]) >= 4.5, `${theme} course text ${item.ink}`);
                }
                if (width === 390) {
                    const markers = await page.evaluate(() => {
                        const colors = Array.from(buildScheduleCourseColorMap({ 1: Array.from({ length: 360 }, (_, i) => ({ name: `扩展课程${i}` })) }).values());
                        const sample = document.createElement('button');
                        sample.className = 'course-card'; sample.hidden = true;
                        document.getElementById('page-schedule').append(sample);
                        const values = colors.map(color => {
                            sample.style.setProperty('--course-color', color);
                            return getComputedStyle(sample, '::before').backgroundColor;
                        });
                        sample.remove(); return values;
                    });
                    for (const marker of markers) assert.ok(contrast(color(marker), [51, 65, 85]) >= 4.5, `${theme} extended palette ${marker}`);
                }
                await page.screenshot({ path: path.join(output, `${theme}-dark-schedule-${width}.png`), animations: 'disabled' });
                await page.evaluate(() => switchPage('evaluation'));
                const primary = await page.locator('#one-click-eval-btn').evaluate(el => ({
                    color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor,
                }));
                assert.ok(contrast(color(primary.color), color(primary.background)) >= 4.5, `${theme} primary button contrast`);
                await page.screenshot({ path: path.join(output, `${theme}-dark-evaluation-${width}.png`), fullPage: true, animations: 'disabled' });
                await page.evaluate(() => switchPage('schedule', { scheduleWeek: 1 }));
                await page.locator('.is-current .course-card').first().waitFor();
            }
            const media = await context.newCDPSession(page);
            await media.send('Emulation.setEmulatedMedia', { features: [
                { name: 'prefers-color-scheme', value: 'dark' },
                { name: 'prefers-reduced-transparency', value: 'reduce' },
            ] });
            await page.evaluate(() => switchPage('home'));
            assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).color), 'rgb(248, 250, 252)');
            if (theme === 'glass') assert.equal(await page.locator('.header').evaluate(el => getComputedStyle(el).backdropFilter), 'none');
            for (const url of ['/admin', '/ad']) {
                await page.goto(`http://urp.test${url}`);
                assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).color), 'rgb(248, 250, 252)');
                await page.screenshot({ path: path.join(output, `${theme}-dark-${url.slice(1)}.png`), fullPage: true, animations: 'disabled' });
            }
            console.log(`PASS ${theme}: layers, dark variables, stable layout, >=4.5 marker/text contrast, solid fallback and shared pages`);
            await context.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
