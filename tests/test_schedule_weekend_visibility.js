const test = require('node:test');
const assert = require('node:assert/strict');

const {
    setScheduleWeekendVisibility,
} = require('../static/js/schedule-layout.js');

function makeElement(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
        classList: {
            toggle(name, force) {
                if (force) classes.add(name);
                else classes.delete(name);
            },
            contains(name) {
                return classes.has(name);
            },
        },
    };
}

test('工作日课表同时隐藏表头和内容的周末列', () => {
    const grid = makeElement();
    const header = makeElement();

    setScheduleWeekendVisibility(false, grid, header);

    assert.equal(grid.classList.contains('no-weekend'), true);
    assert.equal(header.classList.contains('no-weekend'), true);
});

test('周六或周日有课时同时显示两个周末列', () => {
    const grid = makeElement(['no-weekend']);
    const header = makeElement(['no-weekend']);

    setScheduleWeekendVisibility(true, grid, header);

    assert.equal(grid.classList.contains('no-weekend'), false);
    assert.equal(header.classList.contains('no-weekend'), false);
});

test('从有周末课程切换到空周时不会保留七列状态', () => {
    const grid = makeElement();
    const header = makeElement();

    setScheduleWeekendVisibility(true, grid, header);
    setScheduleWeekendVisibility(false, grid, header);

    assert.equal(grid.classList.contains('no-weekend'), true);
    assert.equal(header.classList.contains('no-weekend'), true);
});
