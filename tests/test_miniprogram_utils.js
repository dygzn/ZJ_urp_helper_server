const assert = require('node:assert/strict');
const test = require('node:test');

let format = {};
try {
    format = require('../miniprogram/utils/format.js');
} catch (error) {
    // 保持测试可收集，先让下面的契约断言以失败结束。
}

test('getCurrentWeek calculates the semester week from Monday', () => {
    assert.equal(typeof format.getCurrentWeek, 'function');
    assert.equal(format.getCurrentWeek('2026-03-02', new Date(2026, 2, 2)), 1);
    assert.equal(format.getCurrentWeek('2026-03-02', new Date(2026, 2, 9)), 2);
});

test('getCurrentWeek falls back to week one for invalid input', () => {
    assert.equal(format.getCurrentWeek('', new Date(2026, 2, 9)), 1);
    assert.equal(format.getCurrentWeek('not-a-date', new Date(2026, 2, 9)), 1);
    assert.equal(format.getCurrentWeek('2026-03-09', new Date(2026, 2, 2)), 1);
});

test('groupSchedule sorts courses into weekday groups without mutation', () => {
    assert.equal(typeof format.groupSchedule, 'function');
    const input = {
        1: [
            { '课程名': '周二课程', '星期': '2', '节次': '3' },
            { '课程名': '周一课程', '星期': '1', '节次': '1' },
        ],
    };
    const original = JSON.stringify(input);
    const groups = format.groupSchedule(input);

    assert.deepEqual(groups.map(group => group.day), [1, 2]);
    assert.equal(groups[0].courses[0]['课程名'], '周一课程');
    assert.equal(JSON.stringify(input), original);
});

test('groupSchedule exposes WXML-safe course display fields', () => {
    const groups = format.groupSchedule({
        1: [{
            '课程名': '周一课程',
            '星期': '1',
            '节次': '3',
            '节数': '2',
            '上课地点': 'A101',
        }],
    });

    const course = groups[0].courses[0];
    assert.equal(course.courseName, '周一课程');
    assert.equal(course.period, '3');
    assert.equal(course.duration, '2');
    assert.equal(course.location, 'A101');
});

test('formatScore and formatExam normalize empty and backend values', () => {
    assert.equal(typeof format.formatScore, 'function');
    assert.equal(typeof format.formatExam, 'function');
    assert.equal(format.formatScore('优秀'), '优秀');
    assert.equal(format.formatScore(''), '--');

    assert.deepEqual(
        format.formatExam({
            exam_name: '英语',
            time: '周一 09:00',
            location: 'A101',
            seat: '12',
        }),
        {
            exam_name: '英语',
            time: '周一 09:00',
            location: 'A101',
            seat: '12',
        },
    );
});
