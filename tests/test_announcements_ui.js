const { readDomainSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = readDomainSource('announcements');
const announcementCode = source;

function element() {
    const attributes = new Map();
    const classes = new Set();
    return {
        textContent: '', innerHTML: '', hidden: false, disabled: false,
        classList: {
            toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
            contains: name => classes.has(name),
        },
        setAttribute: (name, value) => attributes.set(name, String(value)),
        getAttribute: name => attributes.get(name),
    };
}

function page(announcements, { failLoad = false } = {}) {
    const nodes = new Map();
    const get = id => {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
    };
    const requests = [];
    const modalCalls = [];
    const pageChanges = [];
    const context = vm.createContext({
        document: { getElementById: get },
        getDeviceId: () => 'device-1',
        openUiModal: modal => modalCalls.push(['open', modal]),
        closeUiModal: modal => modalCalls.push(['close', modal]),
        switchPage: name => pageChanges.push(name),
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            if (failLoad && url === '/api/announcements') throw new Error('offline');
            return { json: async () => url.endsWith('/read')
                ? { success: true }
                : { success: true, announcements } };
        },
        console: { error() {} },
    });
    vm.runInContext(announcementCode, context);
    return { context, get, requests, modalCalls, pageChanges };
}

const items = [
    { id: 1, title: '较早公告', content: '较早公告完整内容', create_time: '2026-09-26T09:00:00', is_read: false, never_show: false },
    { id: 2, title: '最新公告', content: '最新公告第一行\n第二行', create_time: '2026-09-27T09:00:00', is_read: false, never_show: false },
];

test('startup only updates the unread dot and does not open a dialog', async () => {
    const { context, get, modalCalls } = page(items);
    await context.loadAnnouncementIndicator();

    assert.equal(get('announcement-trigger').classList.contains('has-unread'), true);
    assert.match(get('announcement-trigger').getAttribute('aria-label'), /2 条未读/);
    assert.equal(modalCalls.length, 0);
});

test('clicking the icon opens the latest full announcement over the current page', async () => {
    const { context, get, requests, modalCalls, pageChanges } = page(items);
    get('page-title').textContent = '成绩查询';
    await context.openAnnouncementDialog();

    assert.equal(get('announcement-dialog-title').textContent, '最新公告');
    assert.equal(get('announcement-dialog-content').textContent, '最新公告第一行\n第二行');
    assert.equal(get('announcement-dialog-position').textContent, '1 / 2');
    assert.equal(get('page-title').textContent, '成绩查询');
    assert.equal(pageChanges.length, 0);
    assert.deepEqual(modalCalls.map(call => call[0]), ['open']);
    assert.deepEqual(requests.filter(request => request.url.endsWith('/read')).map(request => request.url), ['/api/announcements/2/read']);
    assert.equal(get('announcement-trigger').classList.contains('has-unread'), true);
});

test('next and previous show every full announcement and the dot clears after all are read', async () => {
    const { context, get, requests } = page(items);
    await context.openAnnouncementDialog();
    await context.showNextAnnouncement();

    assert.equal(get('announcement-dialog-title').textContent, '较早公告');
    assert.equal(get('announcement-dialog-content').textContent, '较早公告完整内容');
    assert.equal(get('announcement-dialog-position').textContent, '2 / 2');
    assert.equal(get('announcement-next').disabled, true);
    assert.equal(get('announcement-trigger').classList.contains('has-unread'), false);
    await context.showPreviousAnnouncement();
    assert.equal(get('announcement-dialog-title').textContent, '最新公告');
    assert.equal(requests.filter(request => request.url.endsWith('/read')).length, 2);
});

test('announcement text is inserted as text, not interpreted as markup', async () => {
    const { context, get } = page([{ ...items[1], title: '<script>alert(1)</script>', content: '<img src=x onerror=alert(1)>' }]);
    await context.openAnnouncementDialog();

    assert.equal(get('announcement-dialog-title').textContent, '<script>alert(1)</script>');
    assert.equal(get('announcement-dialog-content').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(get('announcement-dialog-content').innerHTML, '');
});

test('empty and failed announcement loads stay inside the dialog with a clear state', async () => {
    const empty = page([]);
    await empty.context.openAnnouncementDialog();
    assert.equal(empty.get('announcement-dialog-status').textContent, '暂无公告');
    assert.equal(empty.get('announcement-next').disabled, true);
    assert.equal(empty.requests.filter(request => request.url.endsWith('/read')).length, 0);

    const failed = page(items, { failLoad: true });
    await failed.context.openAnnouncementDialog();
    assert.match(failed.get('announcement-dialog-status').textContent, /加载失败/);
    assert.equal(failed.get('announcement-retry').hidden, false);
});

test('more carries the unread announcement count and clears after all items are read', async () => {
    const { context, get } = page(items);
    await context.loadAnnouncementIndicator();
    assert.equal(get('mobile-nav-more').classList.contains('has-unread'), true);
    assert.match(get('mobile-nav-more').getAttribute('aria-label'), /2 条未读公告/);
    assert.equal(get('mobile-announcement-count').textContent, '2 条未读');
    await context.openAnnouncementDialog();
    assert.match(get('mobile-nav-more').getAttribute('aria-label'), /1 条未读公告/);
    await context.showNextAnnouncement();
    assert.equal(get('mobile-nav-more').classList.contains('has-unread'), false);
    assert.equal(get('mobile-nav-more').getAttribute('aria-label'), '更多功能与账号');
    assert.equal(get('mobile-announcement-count').textContent, '');
});
