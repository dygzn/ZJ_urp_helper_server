const { readAppSource } = require('./helpers/app-source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = readAppSource();
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function getScheduleCourseColorKey'), source.indexOf('function showCourseDetail')), context);

function linearRgb(color) {
    const linearize = c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
    if (color.startsWith('#')) return color.slice(1).match(/.{2}/g).map(c => linearize(parseInt(c, 16) / 255));
    const [h, s, l] = color.match(/[\d.]+/g).map(Number);
    const saturation = s / 100, lightness = l / 100;
    const a = saturation * Math.min(lightness, 1 - lightness);
    const channel = n => {
        const k = (n + h / 30) % 12;
        const c = lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return linearize(c);
    };
    return [channel(0), channel(8), channel(4)];
}

function contrastWithWhite(color) {
    const [r, g, b] = linearRgb(color);
    return 1.05 / (.2126 * r + .7152 * g + .0722 * b + .05);
}

function perceptualColor(color) {
    const [r, g, b] = linearRgb(color);
    const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
    const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
    const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
    return [.2104542553 * l + .793617785 * m - .0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
        .0259040371 * l + .7827717662 * m - .808675766 * s];
}

test('course markers have at least 3:1 contrast against the white card', () => {
    const courses = Array.from({ length: 360 }, (_, i) => ({ name: `课程${i}` }));
    for (const color of context.buildScheduleCourseColorMap({ 1: courses }).values()) {
        assert.ok(contrastWithWhite(color) >= 3, `${color} has contrast ${contrastWithWhite(color)}`);
    }
});

test('a twelve-course timetable uses visibly separated colors and varied lightness', () => {
    const courses = Array.from({ length: 12 }, (_, i) => ({name: `课程${i}`}));
    const colors = [...context.buildScheduleCourseColorMap({1: courses}).values()];
    const lab = colors.map(perceptualColor);
    for (let i = 0; i < lab.length; i++) {
        for (let j = i + 1; j < lab.length; j++) {
            const distance = Math.hypot(...lab[i].map((value, k) => value - lab[j][k]));
            assert.ok(distance >= .095, `${colors[i]} and ${colors[j]} are too similar: ${distance}`);
        }
    }
    assert.ok(Math.max(...lab.map(c => c[0])) - Math.min(...lab.map(c => c[0])) >= .15);
});

test('each next course color maximizes its difference from the colors already used', () => {
    const courses = Array.from({length: 12}, (_, i) => ({name: `课程${i}`}));
    const colors = [...context.buildScheduleCourseColorMap({1: courses}).values()];
    const lab = colors.map(perceptualColor);
    const distance = (a, b) => Math.hypot(...a.map((value, k) => value - b[k]));
    for (let i = 1; i < colors.length; i++) {
        const score = candidate => Math.min(...lab.slice(0, i).map(used => distance(candidate, used)));
        const strongest = Math.max(...lab.slice(i).map(score));
        assert.ok(score(lab[i]) >= strongest - 1e-6, `${colors[i]} was used before a more distinct color`);
    }
    const firstSix = lab.slice(0, 6);
    for (let i = 0; i < firstSix.length; i++) {
        for (let j = i + 1; j < firstSix.length; j++) assert.ok(distance(firstSix[i], firstSix[j]) >= .16);
    }
});

test('small timetables use the priority colors before the extended palette', () => {
    const courses = Array.from({length: 12}, (_, i) => ({code: `C${String(i).padStart(2, '0')}`}));
    const full = [...context.buildScheduleCourseColorMap({1: courses}).values()];
    for (const count of [2, 3, 6, 8]) {
        const small = [...context.buildScheduleCourseColorMap({1: courses.slice(0, count)}).values()];
        assert.deepEqual(small, full.slice(0, count));
    }
});

test('large timetables do not repeat exact course colors', () => {
    const courses = Array.from({length: 36}, (_, i) => ({name: `课程${i}`}));
    const colors = [...context.buildScheduleCourseColorMap({1: courses}).values()];
    assert.equal(new Set(colors).size, courses.length);
});

test('course colors stay stable between weeks and input ordering', () => {
    const a = { name: '数学' }, b = { name: '英语' };
    const first = context.buildScheduleCourseColorMap({ 1: [a, b], 2: [a] });
    const second = context.buildScheduleCourseColorMap({ 2: [a], 1: [b, a] });
    assert.deepEqual([...first], [...second]);
});
