const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = readAppSource();
const code = source.slice(source.indexOf('function returnToCurrentScheduleWeek()'), source.indexOf('const PERIOD_TIMES_DEFAULT', source.indexOf('function returnToCurrentScheduleWeek()')));
for (const [name, start, today, expected] of [
    ['returns to the actual teaching week', '2026-09-07', '2026-09-30', 4],
    ['missing semester date does not guess a week', '', '2026-09-30', null],
    ['outside semester range does not silently clamp', '2026-09-07', '2027-09-30', null],
]) {
    test(name, () => {
        const jumps = [], messages = [];
        const context = vm.createContext({
            currentSemesterStartValue: () => start,
            getCalendarChinaToday: () => today,
            SCHEDULE_MIN_WEEK: 1, SCHEDULE_MAX_WEEK: 25,
            jumpToWeek: week => jumps.push(week), showUiToast: message => messages.push(message),
        });
        vm.runInContext(code, context);
        context.returnToCurrentScheduleWeek();
        assert.deepEqual(jumps, expected === null ? [] : [expected]);
        assert.equal(messages.length, expected === null ? 1 : 0);
    });
}
