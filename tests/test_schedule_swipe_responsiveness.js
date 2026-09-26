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
        viewport: { classList: classList(), setPointerCapture() {}, releasePointerCapture() {} },
        track: { classList: classList(), style: style(), addEventListener() {}, removeEventListener() {} },
        dinoLane: { dataset: {}, style: style() },
        panels: [],
    };
    const document = { readyState: 'loading', addEventListener() {}, getElementById() { return null; } };
    const localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    const window = { requestAnimationFrame(callback) { callback(); return 1; }, clearTimeout() {}, setTimeout() { return 1; } };
    const context = vm.createContext({ document, localStorage, window, console, TextEncoder, performance });
    for (const filename of ['schedule-layout.js', 'calendar-export.js', 'main.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js', filename), 'utf8'), context, { filename });
    }
    context.swipeFixture = swipe;
    vm.runInContext('getScheduleSwipeElements = () => swipeFixture;', context);
    return { context, swipe };
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

test('holding a touch swipe briefly does not enter the dinosaur crash lock', () => {
    const { context } = createSwipeContext();
    context.holdCalls = 0;
    vm.runInContext(`
        currentWeek = 3;
        armScheduleDinoHoldTimer = () => { holdCalls++; };
        scheduleSwipeGesture.pointerId = 9;
        scheduleSwipeGesture.pointerType = 'touch';
        scheduleSwipeGesture.startX = 200;
        scheduleSwipeGesture.startY = 100;
        scheduleSwipeGesture.width = 300;
        scheduleSwipeGesture.dragging = true;
    `, context);
    context.move = { pointerId: 9, clientX: 155, clientY: 100, cancelable: true, preventDefault() {} };
    vm.runInContext('renderSchedulePointerMove(move)', context);
    assert.equal(context.holdCalls, 0);
    assert.equal(vm.runInContext('scheduleSwipeGesture.crashed', context), false);
});

test('a queued swipe starts when the current week settles', () => {
    const { context } = createSwipeContext();
    context.directions = [];
    vm.runInContext(`
        currentWeek = 1;
        scheduleQueuedSwipe = 1;
        scheduleSwipeTransition = { week: 2, shouldChange: true, finishNotBefore: 0, onTransitionEnd() {} };
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


test('releasing a fast swipe while airborne continues from its height without replaying takeoff', () => {
    const { context, swipe } = createSwipeContext();
    vm.runInContext(`
        currentWeek = 3;
        setScheduleSwipeTransform = () => {};
        scheduleSwipeGesture.pointerId = 9;
        scheduleSwipeGesture.pointerType = 'touch';
        scheduleSwipeGesture.startX = 200;
        scheduleSwipeGesture.startY = 100;
        scheduleSwipeGesture.startTime = Date.now() - 50;
        scheduleSwipeGesture.width = 300;
        scheduleSwipeGesture.dragging = true;
        scheduleSwipeGesture.obstacleType = 'rock';
    `, context);
    context.move = { pointerId: 9, clientX: 155, clientY: 100, cancelable: true, preventDefault() {} };
    vm.runInContext('renderSchedulePointerMove(move)', context);
    const height = swipe.dinoLane.style['--dino-drag-lift'];
    assert.ok(parseFloat(height) < 0);
    vm.runInContext('handleSchedulePointerEnd(move)', context);
    assert.equal(vm.runInContext('scheduleSwipeTransition.shouldChange', context), true);
    assert.equal(swipe.viewport.classList.contains('is-dino-button-jump'), false);
    assert.equal(swipe.viewport.classList.contains('is-settling'), true);
    assert.equal(swipe.dinoLane.style['--dino-drag-lift'], height);
});

test('drag takeoff and landing have gentle endpoints and clear the obstacle', () => {
    const { resolveScheduleDinoLift } = require('../static/js/schedule-layout.js');
    assert.equal(resolveScheduleDinoLift(140), 0);
    assert.equal(resolveScheduleDinoLift(-114), 0);
    for (const shift of [10, 0, -30, -70]) {
        assert.equal(resolveScheduleDinoLift(shift), 32);
    }
    // A small displacement near an endpoint should not create a sudden vertical step.
    assert.ok(resolveScheduleDinoLift(39.9) < 0.002);
    assert.ok(resolveScheduleDinoLift(-99.9) < 0.002);
    assert.ok(32 - resolveScheduleDinoLift(10.1) < 0.002);
    assert.equal(resolveScheduleDinoLift(0, true), 0);
});
