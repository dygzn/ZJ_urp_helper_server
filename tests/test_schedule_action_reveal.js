const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const layoutSource = fs.readFileSync(path.join(__dirname, '../static/js/schedule-layout.js'), 'utf8');
const template = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');

function makeClassList() {
    const names = new Set();
    return {
        add(name) { names.add(name); },
        remove(...values) { values.forEach(value => names.delete(value)); },
        contains(name) { return names.has(name); },
        toggle(name, enabled) { if (enabled) names.add(name); else names.delete(name); },
    };
}

function createGesturePage() {
    const attrs = new Map([['inert', ''], ['aria-hidden', 'true']]);
    const listeners = new Map();
    const page = { dataset: {}, classList: makeClassList(), addEventListener(name, callback, options) { listeners.set(name, options); } };
    const label = { textContent: '' };
    const fill = { style: { width: '0%' } };
    const pull = {
        style: { height: '0px', setProperty() {} },
        classList: makeClassList(),
        querySelector(selector) { return selector === '.schedule-actions-pull-fill' ? fill : label; },
    };
    const panel = {
        classList: makeClassList(),
        setAttribute(name, value) { attrs.set(name, value); },
        removeAttribute(name) { attrs.delete(name); },
        scrollIntoView() {},
        contains(target) { return target === this; },
    };
    const timetable = { focusCalls: 0, focusOptions: null, focus(options) { this.focusCalls++; this.focusOptions = options; } };
    const nodes = new Map([['page-schedule', page], ['schedule-actions-pull', pull], ['schedule-actions', panel], ['schedule-content', timetable]]);
    const document = {
        readyState: 'loading',
        documentElement: { scrollHeight: 1000 },
        addEventListener() {},
        getElementById(id) { return nodes.get(id) || null; },
    };
    const timers = new Map();
    let nextTimer = 0;
    const window = {
        scrollY: 200,
        innerHeight: 500,
        scrollCalls: 0,
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        scrollTo() { this.scrollCalls++; this.scrollY = 500; },
    };
    const localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    const context = vm.createContext({ document, window, localStorage, console, TextEncoder });
    for (const filename of ['schedule-layout.js', 'calendar-export.js', 'main.js']) {
        vm.runInContext((filename === 'main.js' ? readAppSource() : fs.readFileSync(path.join(__dirname, '../static/js', filename), 'utf8')), context, { filename });
    }
    return { context, attrs, panel, pull, label, window, listeners, timers, page, document, timetable, nodes };
}


function touch(context, y, type = 'move') {
    context.event = { touches: [{identifier: 1, clientX: 180, clientY: y}], cancelable: true, preventDefault() {} };
    vm.runInContext(`handleScheduleActionTouch${type === 'start' ? 'Start' : 'Move'}(event)`, context);
}
test('课程详情打开时，方向键与翻页键用于详情，不展开背景操作区', () => {
    const { context, panel, page } = createGesturePage();
    page.classList.add('active');
    vm.runInContext('uiModalState.activeModal = { id: "course-detail-modal" };', context);
    for (const key of ['ArrowDown', 'PageDown']) {
        let prevented = false;
        context.event = { key, cancelable: true, target: { closest: () => null }, preventDefault() { prevented = true; } };
        vm.runInContext('handleScheduleActionKeyDown(event)', context);
        assert.equal(panel.classList.contains('is-open'), false);
        assert.equal(prevented, false);
    }
});
for (const distance of [80, 170, 219, 220, 260]) {
    test(`touch distance ${distance} only opens after full progress and release`, () => {
        const {context, panel, pull, window} = createGesturePage();
        touch(context, 400, 'start'); touch(context, 400 - distance);
        assert.equal(panel.classList.contains('is-open'), false);
        assert.equal(panel.classList.contains('is-preview'), false);
        assert.equal(parseFloat(pull.querySelector('.schedule-actions-pull-fill').style.width) >= 100, distance >= 220);
        vm.runInContext('handleScheduleActionTouchEnd({touches:[],type:"touchend"})', context);
        assert.equal(panel.classList.contains('is-open'), distance >= 220);
        assert.equal(window.scrollCalls, 0);
    });
}
test('retreating from a full bar or cancelling does not open buttons', () => {
    for (const cancel of [true, false]) {
        const {context, panel} = createGesturePage();
        touch(context, 400, 'start'); touch(context, 150);
        if (!cancel) touch(context, 220);
        vm.runInContext(`handleScheduleActionTouchEnd({touches:[],type:"${cancel ? 'touchcancel' : 'touchend'}"})`, context);
        assert.equal(panel.classList.contains('is-open'), false);
    }
});
test('slight downward movement hides buttons and cannot reopen during the same touch', () => {
    const {context,panel,window} = createGesturePage();
    vm.runInContext('showScheduleActions()', context);
    touch(context, 100, 'start');touch(context, 112);
    assert.equal(panel.classList.contains('is-open'), true);
    touch(context, 130);assert.equal(panel.classList.contains('is-open'), false);
    touch(context, -200);
    vm.runInContext('handleScheduleActionTouchEnd({touches:[]})', context);
    assert.equal(panel.classList.contains('is-open'), false);
    assert.equal(window.scrollCalls, 0);
});
test('wheel needs sustained full progress and idle before opening', () => {
    const {context,panel,timers,pull}=createGesturePage();
    context.event={deltaY:100,deltaMode:0,cancelable:true,preventDefault(){}};
    for(let i=0;i<3;i++) vm.runInContext('handleScheduleActionWheel(event)',context);
    assert.equal(panel.classList.contains('is-open'),false);
    assert.ok(parseFloat(pull.querySelector('.schedule-actions-pull-fill').style.width)<100);
    vm.runInContext('handleScheduleActionWheel(event)',context);
    assert.equal(panel.classList.contains('is-open'),false);
    [...timers.values()].at(-1).callback();
    assert.equal(panel.classList.contains('is-open'),true);
});
test('horizontal swipes do not reveal buttons', () => {
    const {context,panel,pull}=createGesturePage();touch(context,400,'start');
    context.event={touches:[{identifier:1,clientX:50,clientY:390}]};
    vm.runInContext('handleScheduleActionTouchMove(event)',context);
    touch(context,100);
    vm.runInContext('handleScheduleActionTouchEnd({touches:[]})',context);
    assert.equal(panel.classList.contains('is-open'),false);
    assert.equal(pull.classList.contains('is-pulling'),false);
});

test('desktop actions stay accessible when hide or wheel gestures are requested', () => {
    const { context, window, panel, attrs } = createGesturePage();
    window.matchMedia = () => ({ matches: true });
    context.hideScheduleActions();
    assert.equal(panel.classList.contains('is-open'), true);
    assert.equal(attrs.has('inert'), false);
    context.handleScheduleActionWheel({deltaY:-120, cancelable:true, preventDefault(){throw new Error('desktop wheel intercepted');}});
    assert.equal(panel.classList.contains('is-open'), true);
});

test('glass action menu opens without expanding the timetable toolbar', () => {
    const { context, window, panel } = createGesturePage();
    let opens = 0;
    window.ScheduleActionsMenu = { isEnabled: () => true, open: () => { opens++; }, close() {} };
    context.showScheduleActions();
    assert.equal(opens, 1);
    assert.equal(panel.classList.contains('is-open'), false);
});

test('glass action menu closes through the same entry point', () => {
    const { context, window } = createGesturePage();
    let options;
    window.ScheduleActionsMenu = { isEnabled: () => true, open() {}, close: value => { options = value; } };
    context.hideScheduleActions(false);
    assert.equal(options?.restoreFocus, false);
});

test('glass action menu ignores reveal touch, wheel and arrow gestures', () => {
    const { context, window, panel, pull, timers, page } = createGesturePage();
    let opens = 0;
    window.ScheduleActionsMenu = { isEnabled: () => true, open: () => { opens++; }, close() {} };
    page.classList.add('active');
    touch(context, 400, 'start');
    touch(context, 100);
    context.handleScheduleActionTouchEnd({ touches: [], type: 'touchend' });
    context.handleScheduleActionWheel({ deltaY: -260, cancelable: true, preventDefault() { throw new Error('menu mode intercepted scrolling'); } });
    context.handleScheduleActionKeyDown({ key: 'ArrowDown', cancelable: true, target: { closest: () => null }, preventDefault() { throw new Error('menu mode intercepted an arrow'); } });
    assert.equal(opens, 0);
    assert.equal(panel.classList.contains('is-open'), false);
    assert.equal(pull.classList.contains('is-pulling'), false);
    assert.equal(timers.size, 0);
});
