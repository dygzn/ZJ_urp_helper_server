const test = require('node:test');
const assert = require('node:assert/strict');

const scheduleLayout = require('../static/js/schedule-layout.js');


test('历年课程转换为星期和节次对应的周课表位置', () => {
    const model = scheduleLayout.buildHistoricalScheduleGridModel?.([
        {
            '课程名': '软件工程导论',
            '星期': '3',
            '节次': '1',
            '节数': '2',
            '位置': '仙林校区实C-501',
            '课序': '01',
        },
        {
            '课程名': '公差配合与测量技术',
            '星期': '1',
            '节次': '3',
            '节数': '1',
            '位置': '仙林校区实C-502',
            '课序': '01',
        },
        {
            '课程名': '无效课程',
            '星期': '8',
            '节次': '1',
            '节数': '1',
        },
    ]);

    assert.deepEqual(model, {
        days: ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'],
        periods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        courses: [
            {
                name: '公差配合与测量技术',
                location: '仙林校区实C-502',
                classNo: '01',
                day: 1,
                start: 3,
                duration: 1,
                column: 2,
                row: 4,
                sectionText: '第3节',
            },
            {
                name: '软件工程导论',
                location: '仙林校区实C-501',
                classNo: '01',
                day: 3,
                start: 1,
                duration: 2,
                column: 4,
                row: 2,
                sectionText: '第1-2节',
            },
        ],
    });
});


test('历年课表输出完整网格并转义课程内容', () => {
    const html = scheduleLayout.buildHistoricalScheduleGridHtml?.([
        {
            '课程名': '<软件工程>',
            '星期': '3',
            '节次': '1',
            '节数': '2',
            '位置': 'A&B',
            '课序': '01',
        },
    ]);

    assert.match(html, /historical-schedule-grid-scroll/);
    assert.match(html, /星期日/);
    assert.match(html, /第10节/);
    assert.match(html, /grid-column: 4; grid-row: 2 \/ span 2/);
    assert.match(html, /&lt;软件工程&gt;/);
    assert.match(html, /A&amp;B/);
    assert.match(html, /title="&lt;软件工程&gt; · A&amp;B · 第1-2节"/);
    assert.doesNotMatch(html, /<软件工程>/);
});
