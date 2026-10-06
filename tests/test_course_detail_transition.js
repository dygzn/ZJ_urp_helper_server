const test = require('node:test');
const assert = require('node:assert/strict');
const { createCourseDetailTransition } = require('../static/js/course-detail-transition.js');

function fixture({ reduced = false, backdropOpacity = '1' } = {}) {
    const animations = [];
    const listeners = {};
    const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
    function element(bounds) {
        const classes = new Set();
        return {
            style: { setProperty(name, value) { this[name] = value; } }, isConnected: true, children: [], textContent: '高等数学',
            classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
            getBoundingClientRect: () => bounds,
            setAttribute() {}, appendChild(child) { this.children.push(child); }, remove() { this.isConnected = false; },
            animate(frames, options) {
                let resolve, reject;
                const animation = { target: this, frames, options, finished: new Promise((yes, no) => { resolve = yes; reject = no; }),
                    complete: () => resolve(), cancel: () => { animation.cancelled = true; reject(new Error('cancelled')); } };
                animations.push(animation);
                return animation;
            },
        };
    }
    const source = element(rect(90, 220, 44, 130));
    const sourceName = element(rect(94, 227, 36, 40));
    source.querySelector = () => sourceName;
    const panel = element(rect(20, 200, 350, 310));
    const title = element(rect(44, 245, 260, 52));
    panel.children = [element(rect(0, 0, 0, 0)), title, element(rect(0, 0, 0, 0))];
    const modal = element(rect(0, 0, 390, 844));
    const backdrop = element(rect(0, 0, 390, 844));
    const body = panel.children[2];
    modal.querySelector = selector => ({ '.modal-content': panel, '#course-detail-name': title,
        '.course-detail-backdrop': backdrop, '#course-detail-body': body }[selector]);
    const media = { matches: reduced, addEventListener() {} };
    const window = {
        innerWidth: 390, innerHeight: 844, matchMedia: () => media,
        addEventListener: (name, callback) => { listeners[name] = callback; },
        getComputedStyle: (el, pseudo) => pseudo === '::before'
            ? { left: '0px', top: '8px', width: '5px', height: el === source ? '114px' : '294px' }
            : ({ transform: 'none', backgroundColor: el === source ? 'rgb(19, 56, 118)' : 'rgb(255, 255, 255)',
            borderRadius: el === source ? '8px' : '14px', color: el === sourceName ? 'rgb(255,255,255)' : 'rgb(24,38,56)',
            fontSize: el === sourceName ? '13px' : '20px', fontWeight: '600', lineHeight: '26px', opacity: el === backdrop ? backdropOpacity : '1',
            getPropertyValue: name => name === '--course-color' ? 'rgb(19, 56, 118)' : '' }),
    };
    const document = { createElement: () => element(rect(0, 0, 0, 0)) };
    return { controller: createCourseDetailTransition({ window, document }), source, panel, modal, body, backdrop, animations, listeners, media };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('课程详情从点击卡片的位置展开，课程颜色仅用于局部色标', async () => {
    const f = fixture();
    f.controller.open(f.modal, f.source);
    assert.match(f.animations[0].frames[0].transform, /translate\(70px, 20px\) scale\(0\.125/);
    assert.ok(f.animations[0].frames.every(frame => !Object.hasOwn(frame, 'backgroundColor')));
    assert.ok(f.animations.every(animation => animation.frames.every(frame =>
        !Object.hasOwn(frame, 'backgroundColor') && !Object.hasOwn(frame, 'color'))));
    assert.equal(f.modal.style['--course-detail-color'], 'rgb(19, 56, 118)');
    assert.ok(f.source.classList.contains('is-detail-source'));
    f.animations[0].complete(); await flush();
    assert.equal(f.modal.classList.contains('is-course-morphing'), false);
    assert.ok(f.source.classList.contains('is-detail-source'));
});

test('关闭沿原卡片位置收回，收回后只调用一次关闭及焦点恢复回调', async () => {
    const f = fixture(); let closed = 0;
    f.controller.open(f.modal, f.source);
    f.animations[0].complete(); await flush();
    const index = f.animations.length;
    assert.equal(f.controller.close(f.modal, () => closed++), true);
    assert.equal(f.controller.close(f.modal, () => closed++), true);
    assert.equal(closed, 0);
    assert.match(f.animations[index].frames[1].transform, /translate\(70px, 20px\) scale/);
    assert.ok(f.animations[index].frames.every(frame => !Object.hasOwn(frame, 'backgroundColor')));
    f.animations[index].complete(); await flush();
    assert.equal(closed, 1);
    assert.equal(f.source.classList.contains('is-detail-source'), false);
});

test('贯穿卡片的色条随详情尺寸伸展，结束时不跳变', () => {
    const f = fixture();
    f.controller.open(f.modal, f.source);
    const mark = f.animations.find(animation => animation.target.className === 'course-detail-shared-mark');
    const scale = /scale\(([^,]+), ([^)]+)\)/.exec(mark.frames[1].transform);
    assert.ok(scale, '色条在位置移动的同时适配详情的长度');
    assert.ok(Math.abs(Number.parseFloat(mark.target.style.height) * Number(scale[2]) - 294) < 0.1);
});

test('每次打开详情都把独立滚动内容复位，包含减少动态效果模式', () => {
    for (const reduced of [false, true]) {
        const f = fixture({ reduced });
        f.body.scrollTop = 180;
        f.controller.open(f.modal, f.source);
        assert.equal(f.body.scrollTop, 0);
    }
});

test('关闭立即淡出遮罩，在卡片收回之前恢复页面亮度', async () => {
    const f = fixture();
    f.controller.open(f.modal, f.source);
    f.animations[0].complete(); await flush();
    const index = f.animations.length;
    f.controller.close(f.modal, () => {});
    const surface = f.animations[index];
    const backdrop = f.animations.slice(index).find(animation => animation.target === f.backdrop);
    assert.ok(backdrop, '关闭开始时就有单独的遮罩淡出');
    assert.equal(backdrop.frames[0].opacity, '1');
    assert.equal(backdrop.frames[1].opacity, 0);
    assert.ok(surface.options.duration <= 260, '卡片及时收回，减少关闭后的等待');
    assert.ok(backdrop.options.duration < surface.options.duration);
});

test('展开尚未结束就关闭时，遮罩从当前亮度淡出，避免闪回全灰', () => {
    const f = fixture({ backdropOpacity: '0.35' });
    f.controller.open(f.modal, f.source);
    const index = f.animations.length;
    f.controller.close(f.modal, () => {});
    const backdrop = f.animations.slice(index).find(animation => animation.target === f.backdrop);
    assert.ok(backdrop);
    assert.equal(backdrop.frames[0].opacity, '0.35');
    assert.equal(backdrop.frames[1].opacity, 0);
});

test('展开中关闭以及立即切换弹窗，不会被过期动画重新覆盖', async () => {
    const f = fixture(); let closed = 0;
    f.controller.open(f.modal, f.source);
    f.controller.close(f.modal, () => closed++);
    f.controller.reset(f.modal);
    f.controller.open(f.modal, f.source);
    await flush();
    assert.equal(closed, 0);
    assert.ok(f.source.classList.contains('is-detail-source'));
    assert.ok(f.modal.classList.contains('is-course-morphing'));
});

test('减少动态效果或来源卡片已移除时，直接使用原有详情关闭流程', () => {
    const reduced = fixture({ reduced: true });
    reduced.controller.open(reduced.modal, reduced.source);
    assert.equal(reduced.animations.length, 0);
    assert.equal(reduced.controller.close(reduced.modal, () => {}), false);
    const f = fixture();
    f.controller.open(f.modal, f.source);
    f.source.isConnected = false;
    assert.equal(f.controller.close(f.modal, () => {}), false);
    assert.equal(f.modal.classList.contains('is-course-morphing'), false);
});

test('屏幕尺寸变化时结束过渡，保持详情可用；收回时变化则完成关闭', () => {
    const f = fixture(); let closed = 0;
    f.controller.open(f.modal, f.source);
    f.listeners.resize();
    assert.equal(f.modal.classList.contains('is-course-morphing'), false);
    f.controller.close(f.modal, () => closed++);
    f.listeners.resize();
    assert.equal(closed, 1);
    assert.equal(f.source.classList.contains('is-detail-source'), false);
});
