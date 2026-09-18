const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    resolveScheduleSwipe,
    resolveScheduleDinoCue,
    resolveScheduleDinoRelease,
    resolveScheduleButtonSwipe,
    shouldCrashScheduleDino,
    pickScheduleDinoObstacle,
} = require('../static/js/schedule-layout.js');
const scheduleLayout = require('../static/js/schedule-layout.js');

test('当前课表课程卡片保留选课结果字段', () => {
    assert.equal(typeof scheduleLayout.buildScheduleCourseCardData, 'function');
    if (typeof scheduleLayout.buildScheduleCourseCardData !== 'function') return;

    assert.deepEqual(
        scheduleLayout.buildScheduleCourseCardData({
            '课程号': '01318011',
            '课程名': '软件工程导论',
            '学分': '2.0',
            '教师': '刘海艳',
            '课程属性': '任选',
            '考试类型': '考查',
            '修读方式': '正常',
            '选课状态': '选中',
            '节次': '1',
            '节数': '2',
            '位置': '仙林校区实C-501',
            '校区': '仙林校区',
            '教学楼': '实C',
            '教室': '-501',
        }, 3),
        {
            code: '01318011',
            name: '软件工程导论',
            credit: '2.0',
            teacher: '刘海艳',
            courseAttribute: '任选',
            examType: '考查',
            studyMode: '正常',
            selectionStatus: '选中',
            day: '星期三',
            section: 1,
            duration: 2,
            location: '仙林校区实C-501',
            campus: '仙林校区',
            building: '实C',
            room: '-501',
        },
    );
});

test('课程详情展示课程属性、考试类型、修读方式和选课状态', () => {
    assert.equal(typeof scheduleLayout.buildScheduleCourseDetailHtml, 'function');
    if (typeof scheduleLayout.buildScheduleCourseDetailHtml !== 'function') return;

    const html = scheduleLayout.buildScheduleCourseDetailHtml({
        code: '01318011',
        name: '软件工程导论',
        credit: '2.0',
        teacher: '刘海艳',
        courseAttribute: '任选',
        examType: '考查',
        studyMode: '正常',
        selectionStatus: '选中',
        day: '星期三',
        section: 1,
        duration: 2,
        location: '仙林校区实C-501',
        campus: '仙林校区',
        building: '实C',
        room: '-501',
    });

    assert.match(html, /课程属性<\/span><span>任选<\/span>/);
    assert.match(html, /考试类型<\/span><span>考查<\/span>/);
    assert.match(html, /修读方式<\/span><span>正常<\/span>/);
    assert.match(html, /选课状态<\/span><span>选中<\/span>/);
});

const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'static', 'css', 'style.css'), 'utf8');

test('向左拖动超过阈值后切换到下一周', () => {
    assert.deepEqual(
        resolveScheduleSwipe({
            deltaX: -120,
            duration: 280,
            viewportWidth: 390,
            currentWeek: 8,
        }),
        { shouldChange: true, direction: 1, week: 9 },
    );
});

test('短距离且速度不足的拖动会回弹到当前周', () => {
    assert.deepEqual(
        resolveScheduleSwipe({
            deltaX: -32,
            duration: 260,
            viewportWidth: 390,
            currentWeek: 8,
        }),
        { shouldChange: false, direction: 0, week: 8 },
    );
});

test('快速轻扫也可以切换周次', () => {
    assert.deepEqual(
        resolveScheduleSwipe({
            deltaX: -48,
            duration: 70,
            viewportWidth: 390,
            currentWeek: 8,
        }),
        { shouldChange: true, direction: 1, week: 9 },
    );
});

test('第 1 周向右滑和第 25 周向左滑都不会越界', () => {
    assert.deepEqual(
        resolveScheduleSwipe({
            deltaX: 160,
            duration: 200,
            viewportWidth: 390,
            currentWeek: 1,
        }),
        { shouldChange: false, direction: 0, week: 1 },
    );
    assert.deepEqual(
        resolveScheduleSwipe({
            deltaX: -160,
            duration: 200,
            viewportWidth: 390,
            currentWeek: 25,
        }),
        { shouldChange: false, direction: 0, week: 25 },
    );
});

test('周次按钮只为有效的相邻周生成定向动画计划', () => {
    assert.equal(typeof resolveScheduleButtonSwipe, 'function');
    assert.deepEqual(
        resolveScheduleButtonSwipe({ delta: -1, currentWeek: 8 }),
        { shouldChange: true, direction: -1, week: 7 },
    );
    assert.deepEqual(
        resolveScheduleButtonSwipe({ delta: 1, currentWeek: 8 }),
        { shouldChange: true, direction: 1, week: 9 },
    );
    assert.deepEqual(
        resolveScheduleButtonSwipe({ delta: -1, currentWeek: 1 }),
        { shouldChange: false, direction: 0, week: 1 },
    );
    assert.deepEqual(
        resolveScheduleButtonSwipe({ delta: 1, currentWeek: 25 }),
        { shouldChange: false, direction: 0, week: 25 },
    );
});

test('障碍物随拖动靠近且在独立阈值前不会被越过', () => {
    assert.deepEqual(
        resolveScheduleDinoCue({
            deltaX: -24,
            viewportWidth: 390,
            currentWeek: 8,
        }),
        {
            active: true,
            blocked: false,
            direction: 1,
            progress: 0.342,
            obstacleProgress: 0.622,
            crossedObstacle: false,
            targetWeek: 9,
        },
    );
});

test('越障阈值早于换周阈值以允许跳过后再回退', () => {
    assert.deepEqual(
        resolveScheduleDinoCue({
            deltaX: -48,
            viewportWidth: 390,
            currentWeek: 8,
        }),
        {
            active: true,
            blocked: false,
            direction: 1,
            progress: 0.684,
            obstacleProgress: 1.244,
            crossedObstacle: true,
            targetWeek: 9,
        },
    );
});

test('空中按住不动达到 600ms 时触发撞击', () => {
    assert.equal(shouldCrashScheduleDino({ airborne: true, pointerDown: true, idleMs: 599 }), false);
    assert.equal(shouldCrashScheduleDino({ airborne: true, pointerDown: true, idleMs: 600 }), true);
});

test('已经落地或已经松手时不会触发空中撞击', () => {
    assert.equal(shouldCrashScheduleDino({ airborne: false, pointerDown: true, idleMs: 400 }), false);
    assert.equal(shouldCrashScheduleDino({ airborne: true, pointerDown: false, idleMs: 400 }), false);
});

test('拖向学期边界时不会越过障碍或进入无效周次', () => {
    assert.deepEqual(
        resolveScheduleDinoCue({
            deltaX: -80,
            viewportWidth: 390,
            currentWeek: 25,
        }),
        {
            active: true,
            blocked: true,
            direction: 1,
            progress: 1,
            obstacleProgress: 1,
            crossedObstacle: false,
            targetWeek: 25,
        },
    );
});

test('每次手势按随机值稳定选择一种障碍物', () => {
    assert.equal(pickScheduleDinoObstacle(0), 'cactus-single');
    assert.equal(pickScheduleDinoObstacle(0.4), 'cactus-double');
    assert.equal(pickScheduleDinoObstacle(0.99), 'rock');
});

test('越障前取消手势时发射火球', () => {
    assert.equal(
        resolveScheduleDinoRelease({ hadObstacle: true, crossedObstacle: false, shouldChange: false }),
        'fireball',
    );
});

test('越障后未换周时反向跳回原位', () => {
    assert.equal(
        resolveScheduleDinoRelease({ hadObstacle: true, crossedObstacle: true, shouldChange: false }),
        'reverse-jump',
    );
});

test('成功换周时完成动作并在页面落定后清场', () => {
    assert.equal(
        resolveScheduleDinoRelease({ hadObstacle: true, crossedObstacle: true, shouldChange: true }),
        'complete',
    );
});

test('课程表只保留无文案的小恐龙跑道和一个周次控件', () => {
    const scheduleMarkup = template.match(/<div id="page-schedule"[\s\S]*?<div id="page-exams"/)?.[0] || '';

    assert.match(scheduleMarkup, /class="schedule-dino-lane"/);
    assert.match(scheduleMarkup, /class="schedule-dino-character"/);
    assert.match(scheduleMarkup, /class="schedule-dino-fireball"/);
    assert.match(scheduleMarkup, /class="schedule-dino-fragments"/);
    assert.match(scheduleMarkup, /class="schedule-dino-dizzy"/);
    assert.doesNotMatch(scheduleMarkup, /跨周小彩蛋|拖动课程表|上一周 ·|下一周 ·/);
    assert.equal((scheduleMarkup.match(/id="week-select"/g) || []).length, 1);
    assert.equal((scheduleMarkup.match(/class="current-week"/g) || []).length, 0);
});

test('课程表内容区以小恐龙跑道开场且不重复标题和操作说明', () => {
    const scheduleMarkup = template.match(/<div id="page-schedule"[\s\S]*?<div id="page-exams"/)?.[0] || '';

    assert.doesNotMatch(scheduleMarkup, /<h2>课程表<\/h2>/);
    assert.doesNotMatch(scheduleMarkup, /<p class="page-section-desc">左右滑动即可切换周次/);
    assert.match(scheduleMarkup, /<div class="schedule-container">\s*<div id="schedule-message"/);
});

test('上一周和下一周按钮接入定向越障动画', () => {
    const scheduleMarkup = template.match(/<div id="page-schedule"[\s\S]*?<div id="page-exams"/)?.[0] || '';

    assert.match(scheduleMarkup, /onclick="changeWeek\(-1, true\)"[^>]*>上一周/);
    assert.match(scheduleMarkup, /onclick="changeWeek\(1, true\)"[^>]*>下一周/);
    assert.match(stylesheet, /\.is-dino-button-jump \.schedule-dino-obstacle[\s\S]*scheduleDinoButtonObstacle/);
});

test('绿色小恐龙在没有手势时也保持奔跑动画', () => {
    const dinoRule = stylesheet.match(/\.schedule-dino-character\s*\{[\s\S]*?\}/)?.[0] || '';

    assert.match(dinoRule, /color:\s*#34a853/i);
    assert.match(dinoRule, /animation:\s*scheduleDinoRun/);
});

test('小恐龙固定在中央且跳跃过程只有垂直位移', () => {
    const dinoRule = stylesheet.match(/\.schedule-dino-character\s*\{[\s\S]*?\}/)?.[0] || '';
    const jumpRule = stylesheet.match(/@keyframes scheduleDinoJump\s*\{[\s\S]*?\n\}/)?.[0] || '';

    assert.match(dinoRule, /left:\s*50%/);
    assert.match(jumpRule, /translateX\(-50%\)/);
    assert.doesNotMatch(jumpRule, /translateX\((?:70|140)px\)/);
});

test('撞击状态会暂停跑道背景', () => {
    assert.match(
        stylesheet,
        /\.schedule-swipe-viewport\.is-dino-crashed[\s\S]*animation-play-state:\s*paused/,
    );
});

test('星期名称和日期在表头中按上下两行排列', () => {
    const headerRule = stylesheet.match(/\.schedule-header-day\s*\{[\s\S]*?\}/)?.[0] || '';

    assert.match(headerRule, /display:\s*flex/);
    assert.match(headerRule, /flex-direction:\s*column/);
});
