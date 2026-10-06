const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function classList() {
    const values = new Set();
    return {
        add(...names) { names.forEach(name => values.add(name)); },
        remove(...names) { names.forEach(name => values.delete(name)); },
        contains(value) { return values.has(value); },
        toggle(value, enabled) { if (enabled) values.add(value); else values.delete(value); },
    };
}

function createSwipeContext() {
    const style = () => ({ setProperty(name, value) { this[name] = value; }, transform: '' });
    const swipe = {
        viewport: { clientWidth: 300, classList: classList(), setPointerCapture() {}, releasePointerCapture() {} },
        track: { classList: classList(), style: style(), addEventListener() {}, removeEventListener() {} },
        panels: [],
    };
    const document = { readyState: 'loading', addEventListener() {}, getElementById() { return null; } };
    const localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    const timers = [];
    const window = { requestAnimationFrame(callback) { callback(); return 1; }, clearTimeout() {},
        setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; } };
    const context = vm.createContext({ document, localStorage, window, console, TextEncoder, performance });
    for (const filename of ['schedule-layout.js', 'calendar-export.js', 'main.js']) {
        vm.runInContext((filename === 'main.js' ? readAppSource() : fs.readFileSync(path.join(__dirname, '../static/js', filename), 'utf8')), context, { filename });
    }
    context.swipeFixture = swipe;
    vm.runInContext('getScheduleSwipeElements = () => swipeFixture;', context);
    return { context, swipe, timers };
}

test('a second mobile swipe during the settling animation is queued instead of discarded', () => {
    const { context } = createSwipeContext();
    vm.runInContext('currentWeek = 1; scheduleSwipeTransition = { week: 2, shouldChange: true };', context);
    context.start = { pointerId: 7, pointerType: 'touch', clientX: 200, clientY: 100, target: { closest() { return null; } } };
    context.move = { pointerId: 7, clientX: 100, clientY: 100, cancelable: true, preventDefault() {} };
    vm.runInContext('handleSchedulePointerDown(start); handleSchedulePointerMove(move); handleSchedulePointerEnd(move);', context);
    assert.equal(vm.runInContext('scheduleQueuedSwipe', context), 1);

    context.directions = [];
    vm.runInContext('scheduleSwipeTransition = null; changeWeek = delta => directions.push(delta); flushQueuedScheduleSwipe();', context);
    assert.deepEqual(context.directions, [1]);
});

for (const pointerType of ['touch', 'mouse']) {
    test(`holding a ${pointerType} drag keeps horizontal tracking without scheduling timers`, () => {
        const { context, swipe, timers } = createSwipeContext();
        context.start = { pointerId: 9, pointerType, button: 0, clientX: 200, clientY: 100,
            target: { closest() { return null; } } };
        context.move = { pointerId: 9, clientX: 155, clientY: 100, cancelable: true, preventDefault() {} };
        vm.runInContext('currentWeek = 3; handleSchedulePointerDown(start); renderSchedulePointerMove(move);', context);
        assert.equal(swipe.track.style.transform, 'translate3d(calc(-33.333333% + -45px), 0, 0)');
        context.move.clientX = 120;
        vm.runInContext('scheduleSwipeGesture.startTime = Date.now() - 1000; renderSchedulePointerMove(move);', context);
        assert.equal(swipe.track.style.transform, 'translate3d(calc(-33.333333% + -80px), 0, 0)');
        assert.equal(timers.length, 0);
        assert.equal(swipe.viewport.classList.contains('is-swiping'), true);
    });
}

test('a queued swipe starts when the current week settles', () => {
    const { context } = createSwipeContext();
    context.directions = [];
    vm.runInContext(`
        currentWeek = 1;
        scheduleQueuedSwipe = 1;
        scheduleSwipeTransition = { week: 2, shouldChange: true, onTransitionEnd() {} };
        changeWeek = delta => directions.push(delta);
        updateScheduleDates = () => {};
        setScheduleSwipeTransform = () => {};
        loadSchedule = () => {};
        finishScheduleSwipeTransition();
    `, context);
    assert.equal(vm.runInContext('currentWeek', context), 2);
    assert.deepEqual(context.directions, [1]);
});

test('drag frames reuse the timetable elements instead of querying every frame', () => {
    const { context } = createSwipeContext();
    context.lookups = 0;
    vm.runInContext('getScheduleSwipeElements = () => { lookups++; return swipeFixture; }; currentWeek = 3;', context);
    context.start = { pointerId: 4, pointerType: 'touch', clientX: 200, clientY: 100, target: { closest() { return null; } } };
    context.move = { pointerId: 4, clientX: 155, clientY: 100, cancelable: true, preventDefault() {} };
    vm.runInContext('handleSchedulePointerDown(start); renderSchedulePointerMove(move); renderSchedulePointerMove(move);', context);
    assert.equal(context.lookups, 1);
});

test('a fresh tap on a course after a swipe is not mistaken for the swipe click', () => {
    const { context } = createSwipeContext();
    context.tap = { pointerId: 10, pointerType: 'touch', target: { closest() { return {}; } } };
    context.click = { preventDefault() { throw new Error('fresh course tap suppressed'); }, stopPropagation() {} };
    vm.runInContext('suppressScheduleSwipeClick = true; handleSchedulePointerDown(tap); handleScheduleSwipeClick(click);', context);
});

test('the synthetic click from a swipe remains suppressed until another tap starts', () => {
    const { context } = createSwipeContext();
    let prevented = false;
    context.click = { preventDefault() { prevented = true; }, stopPropagation() {} };
    vm.runInContext('suppressScheduleSwipeClick = true; handleScheduleSwipeClick(click);', context);
    assert.equal(prevented, true);
});


test('releasing a fast swipe smoothly settles the horizontal track', () => {
    const { context, swipe } = createSwipeContext();
    context.start = { pointerId: 9, pointerType: 'touch', clientX: 200, clientY: 100,
        target: { closest() { return null; } } };
    context.move = { pointerId: 9, clientX: 155, clientY: 100, cancelable: true, preventDefault() {} };
    vm.runInContext(`
        currentWeek = 3;
        handleSchedulePointerDown(start);
        scheduleSwipeGesture.startTime = Date.now() - 50;
        renderSchedulePointerMove(move);
        handleSchedulePointerEnd(move);
    `, context);
    assert.equal(vm.runInContext('scheduleSwipeTransition.shouldChange', context), true);
    assert.equal(vm.runInContext('scheduleSwipeTransition.week', context), 4);
    assert.equal(swipe.viewport.classList.contains('is-settling'), true);
    assert.equal(swipe.viewport.classList.contains('is-swiping'), false);
    assert.equal(swipe.track.classList.contains('is-animating'), true);
    assert.equal(swipe.track.style.transform, 'translate3d(calc(-33.333333% + -300px), 0, 0)');
});

for (const delta of [-1, 1]) {
    test(`week button ${delta} finishes as soon as the horizontal transition ends`, () => {
        const { context, swipe } = createSwipeContext();
        context.delta = delta;
        vm.runInContext(`
            currentWeek = 3;
            ensureScheduleSwipePanels = () => swipeFixture;
            getScheduleSwipeWidth = () => 300;
            updateScheduleDates = () => {};
            loadSchedule = () => {};
            changeWeek(delta, true);
        `, context);
        assert.equal(swipe.track.style.transform, `translate3d(calc(-33.333333% + ${-delta * 300}px), 0, 0)`);
        assert.equal(vm.runInContext('currentWeek', context), 3);
        assert.equal(swipe.track.classList.contains('is-animating'), true);
        context.end = { target: swipe.track, propertyName: 'transform' };
        vm.runInContext('scheduleSwipeTransition.onTransitionEnd(end);', context);
        assert.equal(vm.runInContext('currentWeek', context), 3 + delta);
        assert.equal(vm.runInContext('scheduleSwipeTransition', context), null);
        assert.equal(swipe.viewport.classList.contains('is-settling'), false);
    });
}

for (const [week, endX, cancelled] of [[1, 280, false], [25, 120, false], [3, 120, true]]) {
    test(`week ${week} ${cancelled ? 'cancelled drag' : 'boundary drag'} returns to the same week`, () => {
        const { context, swipe } = createSwipeContext();
        context.week = week;
        context.cancelled = cancelled;
        context.start = { pointerId: 9, pointerType: 'touch', clientX: 200, clientY: 100,
            target: { closest() { return null; } } };
        context.end = { pointerId: 9, clientX: endX, clientY: 100, cancelable: true, preventDefault() {} };
        vm.runInContext(`
            currentWeek = week;
            handleSchedulePointerDown(start);
            renderSchedulePointerMove(end);
            handleSchedulePointerEnd(end, cancelled);
        `, context);
        assert.equal(vm.runInContext('scheduleSwipeTransition.shouldChange', context), false);
        assert.equal(swipe.track.style.transform, 'translate3d(calc(-33.333333% + 0px), 0, 0)');
        vm.runInContext('finishScheduleSwipeTransition();', context);
        assert.equal(vm.runInContext('currentWeek', context), week);
    });
}
