const { installApi } = require('./helpers/browser-api');
const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function workspace(width = 390) {
    const nodes = new Map();
    const listeners = {};
    let document;
    function element(id, page) {
        const attributes = new Map(page ? [['data-page', page]] : []);
        const classes = new Set();
        return {
            id, textContent: '', isConnected: true,
            classList: {
                contains: name => classes.has(name),
                add: name => classes.add(name), remove: name => classes.delete(name),
                toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
            },
            setAttribute: (name, value) => attributes.set(name, String(value)),
            getAttribute: name => attributes.get(name) ?? null,
            removeAttribute: name => attributes.delete(name),
            focus() { document.activeElement = this; },
        };
    }
    const pages = ['home', 'schedule', 'grades', 'more', 'evaluation', 'lab', 'feedback'];
    pages.forEach(page => nodes.set(`page-${page}`, element(`page-${page}`)));
    const links = pages.map(page => element(`drawer-${page}`, page));
    links.push(...['home', 'schedule', 'grades'].map(page => element(`bottom-${page}`, page)));
    for (const id of ['page-title', 'sidebar', 'menu-trigger', 'mobile-nav-more', 'overlay']) nodes.set(id, element(id));
    const close = element('close'), account = element('account');
    nodes.get('sidebar').querySelector = () => close;
    nodes.get('sidebar').querySelectorAll = () => [close, account];
    document = {
        readyState: 'loading', activeElement: null,
        body: element('body'),
        addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
        getElementById: id => nodes.get(id) || null,
        querySelector: () => null,
        querySelectorAll: selector => selector === '.nav-item' ? links
            : selector === '.page' ? pages.map(page => nodes.get(`page-${page}`)) : [],
    };
    const context = vm.createContext({
        document, console, TextEncoder,
        window: { matchMedia: query => ({ matches: query.includes('1100') ? width >= 1100 : width <= 768 }) },
        localStorage: { getItem: () => null, setItem() {} },
    });
    installApi(context);
    vm.runInContext(readAppSource(), context);
    vm.runInContext('loadPageData = () => {}; hideScheduleActions = () => {}; resetQueuedScheduleSwipe = () => {};', context);
    return {context, document, nodes, links, close, account, listeners};
}

test('pointer interaction hides extra focus rings without moving focus', () => {
    const {document, nodes, listeners} = workspace();
    const trigger = nodes.get('mobile-nav-more');
    trigger.focus();
    for (const listener of listeners.pointerdown || []) listener({pointerType: 'touch'});
    assert.equal(document.body.getAttribute('data-focus-input'), 'pointer');
    assert.equal(document.activeElement, trigger);
});

test('Tab enables keyboard focus rings and a later mouse click disables them', () => {
    const {document, listeners} = workspace();
    const keydown = event => { for (const listener of listeners.keydown || []) listener(event); };
    keydown({key: 'Tab'});
    assert.equal(document.body.getAttribute('data-focus-input'), 'keyboard');
    for (const listener of listeners.pointerdown || []) listener({pointerType: 'mouse'});
    assert.equal(document.body.getAttribute('data-focus-input'), 'pointer');
    keydown({key: 'Enter'});
    assert.equal(document.body.getAttribute('data-focus-input'), 'keyboard');
});

test('typing and modifier shortcuts do not switch the focus display mode', () => {
    const {document, listeners} = workspace();
    for (const listener of listeners.pointerdown || []) listener({pointerType: 'mouse'});
    for (const event of [{key: 'a'}, {key: 'Shift'}, {key: 'Tab', ctrlKey: true}, {key: 'ArrowLeft', metaKey: true}]) {
        for (const listener of listeners.keydown || []) listener(event);
    }
    assert.equal(document.body.getAttribute('data-focus-input'), 'pointer');
});

test('switching a primary page keeps drawer and bottom navigation selected together', () => {
    const { context, links, nodes } = workspace();
    context.switchPage('grades');
    assert.deepEqual(links.filter(link => link.getAttribute('aria-current') === 'page').map(link => link.id), ['drawer-grades', 'bottom-grades']);
    assert.equal(nodes.get('mobile-nav-more').classList.contains('active'), false);
    context.switchPage('evaluation');
    assert.equal(nodes.get('mobile-nav-more').classList.contains('active'), true);
    assert.equal(nodes.get('mobile-nav-more').getAttribute('aria-current'), 'true');
    assert.equal(links.find(link => link.id === 'bottom-grades').getAttribute('aria-current'), null);
    context.switchPage('home');
    assert.equal(nodes.get('mobile-nav-more').getAttribute('aria-current'), null);
});

test('mobile more switches to its own page without a dialog, overlay or scroll lock', () => {
    const { context, document, nodes } = workspace();
    context.openSidebar();
    assert.equal(context.currentPage, 'more');
    assert.equal(nodes.get('page-more').classList.contains('active'), true);
    assert.equal(nodes.get('mobile-nav-more').classList.contains('active'), true);
    assert.equal(nodes.get('sidebar').classList.contains('active'), false);
    assert.equal(nodes.get('overlay').classList.contains('active'), false);
    assert.equal(document.body.classList.contains('ui-locked'), false);
    assert.equal(nodes.get('mobile-nav-more').getAttribute('aria-expanded'), null);
});

test('tablet drawer keeps using the header menu trigger', () => {
    const { context, document, nodes } = workspace(1024);
    context.openSidebar();
    assert.equal(nodes.get('menu-trigger').getAttribute('aria-expanded'), 'true');
    context.closeSidebar();
    assert.equal(document.activeElement, nodes.get('menu-trigger'));
});

test('keyboard focus stays inside the tablet navigation drawer in both directions', () => {
    const { context, document, close, account } = workspace(1024);
    context.openSidebar();
    let prevented = false;
    document.activeElement = account;
    context.handleUiKeydown({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(document.activeElement, close);
    context.handleUiKeydown({ key: 'Tab', shiftKey: true, preventDefault() {} });
    assert.equal(document.activeElement, account);
});

test('mobile page changes focus the visible content heading rather than the removed header', () => {
    const { context, document, nodes } = workspace();
    const heading = { setAttribute() {}, getClientRects: () => [{}], focus() { document.activeElement = this; } };
    const hiddenHeading = { getClientRects: () => [] };
    nodes.get('page-grades').querySelectorAll = () => [hiddenHeading, heading];
    context.focusCurrentPage('grades');
    assert.equal(document.activeElement, heading);
});

test('a mobile page without a heading receives focus and an accessible name', () => {
    const { context, document, nodes } = workspace();
    nodes.get('page-schedule').querySelectorAll = () => [];
    context.switchPage('schedule');
    context.focusCurrentPage('schedule');
    assert.equal(document.activeElement, nodes.get('page-schedule'));
    assert.equal(nodes.get('page-schedule').getAttribute('aria-label'), '日程表');
});

test('more page still syncs account and announcements without academic status widget', () => {
    const {context,nodes}=workspace();
    const moved=[];
    const header={append(){}};
    nodes.set('announcement-trigger',{parentElement:header});
    nodes.set('mobile-announcement-slot',{append:element=>moved.push(element)});
    nodes.set('more-account-name',{textContent:''});
    context.initMobileWorkspaceLayout();
    assert.equal(moved.length,1);
    assert.equal(nodes.get('more-account-name').textContent,'访客');
});
