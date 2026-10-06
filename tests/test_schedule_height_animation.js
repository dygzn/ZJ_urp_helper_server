const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function createContext(reduced = false) {
    const animations = [];
    const track = { animate(frames, options) {
        const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; } };
        animations.push(animation);
        return animation;
    } };
    const context = vm.createContext({
        window: { matchMedia: () => ({ matches: reduced }) },
        document: { readyState: 'loading', addEventListener() {}, getElementById() {} },
        localStorage: { getItem() { return null; } }, console, TextEncoder, track,
    });
    vm.runInContext(readAppSource(), context);
    return { context, animations };
}

test('a new height transition cancels the previous one and releases its fixed height when finished', () => {
    const { context, animations } = createContext();
    vm.runInContext('animateScheduleHeight(track, 700, 550, true)', context);
    assert.equal(animations[0].options.fill, 'forwards');
    vm.runInContext('animateScheduleHeight(track, 620, 800)', context);
    assert.equal(animations[0].cancelled, true);
    assert.equal(animations[1].frames[0].height, '620px');
    assert.equal(animations[1].frames[1].height, '800px');
    assert.equal(animations[1].options.fill, 'none');
    animations[1].onfinish();
    assert.equal(vm.runInContext('scheduleHeightAnimation', context), null);
});

test('reduced motion and unchanged heights do not create a height animation', () => {
    const reduced = createContext(true);
    vm.runInContext('animateScheduleHeight(track, 700, 550)', reduced.context);
    assert.equal(reduced.animations.length, 0);
    const normal = createContext();
    vm.runInContext('animateScheduleHeight(track, 550, 550)', normal.context);
    assert.equal(normal.animations.length, 0);
});
