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
    const page = { dataset: {}, addEventListener(name, callback, options) { listeners.set(name, options); } };
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
        contains() { return false; },
    };
    const nodes = new Map([['page-schedule', page], ['schedule-actions-pull', pull], ['schedule-actions', panel]]);
    const document = {
        readyState: 'loading',
        documentElement: { scrollHeight: 1000 },
        addEventListener() {},
        getElementById(id) { return nodes.get(id) || null; },
    };
    const window = {
        scrollY: 200,
        innerHeight: 500,
        scrollCalls: 0,
        setTimeout() { return 1; },
        clearTimeout() {},
        scrollTo() { this.scrollCalls++; this.scrollY = 500; },
    };
    const localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    const context = vm.createContext({ document, window, localStorage, console, TextEncoder });
    for (const filename of ['schedule-layout.js', 'calendar-export.js', 'main.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js', filename), 'utf8'), context, { filename });
    }
    return { context, attrs, panel, pull, window, listeners };
}

test('the schedule pull has resistance and opens only after sustained upward movement', () => {
    const context = vm.createContext({ Math });
    vm.runInContext(layoutSource, context);
    const atRest = vm.runInContext('resolveScheduleActionPull(0)', context);
    const shortPull = vm.runInContext('resolveScheduleActionPull(80)', context);
    const nearBreak = vm.runInContext('resolveScheduleActionPull(169)', context);
    const released = vm.runInContext('resolveScheduleActionPull(170)', context);

    assert.equal(atRest.offset, 0);
    assert.equal(shortPull.shouldOpen, false);
    assert.ok(shortPull.offset > 0 && shortPull.offset < 80);
    assert.ok(nearBreak.offset - shortPull.offset < 89);
    assert.equal(nearBreak.shouldOpen, false);
    assert.equal(released.shouldOpen, true);
    assert.equal(vm.runInContext('resolveScheduleActionPull(-50).offset', context), 0);
});

test('course cards occupy the correct timetable rows at every screen size', () => {
    const context = vm.createContext({ Math });
    vm.runInContext(layoutSource, context);
    const style = vm.runInContext('scheduleCourseGridPlacement(3, 2)', context);
    assert.equal(style, 'grid-row: 3 / span 2; grid-column: 1;');
    assert.equal(vm.runInContext('scheduleCourseGridPlacement(1, 1)', context),
        'grid-row: 1 / span 1; grid-column: 1;');
});

test('schedule controls are below the timetable and hidden at rest', () => {
    const schedule = template.slice(template.indexOf('id="page-schedule"'), template.indexOf('id="page-exams"'));
    const exams = template.slice(template.indexOf('id="page-exams"'), template.indexOf('id="page-grades"'));

    assert.ok(schedule.indexOf('id="schedule-content"') < schedule.indexOf('id="schedule-actions"'));
    assert.match(schedule, /id="schedule-actions"[^>]*inert[^>]*aria-hidden="true"/);
    assert.ok(schedule.indexOf('id="update-schedule-btn"') < schedule.indexOf('openCalendarExport(\'all\')'));
    assert.ok(exams.indexOf('id="exams-content"') < exams.indexOf('class="action-bar exams-actions"'));
});

test('wheel input opens schedule actions only after reaching the page bottom and pushing twice', () => {
    const { context, attrs, panel, pull, window } = createGesturePage();
    context.wheelEvent = () => ({ deltaY: 100, deltaMode: 0, cancelable: true, preventDefault() {} });
    vm.runInContext('handleScheduleActionWheel(wheelEvent())', context);
    assert.equal(panel.classList.contains('is-open'), false);
    assert.equal(pull.style.height, '0px');

    window.scrollY = 500;
    vm.runInContext('handleScheduleActionWheel(wheelEvent())', context);
    assert.equal(panel.classList.contains('is-open'), false);
    assert.equal(pull.style.height, '0px');
    assert.equal(window.scrollCalls, 0);

    vm.runInContext('handleScheduleActionWheel(wheelEvent())', context);
    assert.equal(panel.classList.contains('is-open'), true);
    assert.equal(attrs.get('aria-hidden'), 'false');
    assert.equal(attrs.has('inert'), false);

    vm.runInContext('hideScheduleActions()', context);
    assert.equal(panel.classList.contains('is-open'), false);
    assert.equal(attrs.get('aria-hidden'), 'true');
    assert.equal(attrs.has('inert'), true);
});

test('a horizontal touch does not reveal controls, but a sustained upward pull does', () => {
    const { context, panel, window } = createGesturePage();
    window.scrollY = 500;
    context.prevented = 0;
    context.touchEvent = (x, y) => ({ touches: [{ identifier: 1, clientX: x, clientY: y }], cancelable: true, preventDefault() { context.prevented++; } });
    vm.runInContext('handleScheduleActionTouchStart(touchEvent(200, 300))', context);
    vm.runInContext('handleScheduleActionTouchMove(touchEvent(100, 290))', context);
    assert.equal(panel.classList.contains('is-open'), false);
    vm.runInContext('handleScheduleActionTouchMove(touchEvent(100, 100))', context);
    assert.equal(panel.classList.contains('is-open'), false);

    vm.runInContext('handleScheduleActionTouchEnd({ touches: [] })', context);
    vm.runInContext('handleScheduleActionTouchStart(touchEvent(200, 300))', context);
    vm.runInContext('handleScheduleActionTouchMove(touchEvent(200, 205))', context);
    assert.equal(panel.classList.contains('is-open'), false);
    vm.runInContext('handleScheduleActionTouchMove(touchEvent(200, 125))', context);
    assert.equal(panel.classList.contains('is-open'), true);
    assert.equal(context.prevented, 0);
});

test('schedule pull listens passively so touch scrolling stays native', () => {
    const { context, listeners } = createGesturePage();
    vm.runInContext('initScheduleActions()', context);
    assert.equal(listeners.get('touchmove').passive, true);
});
