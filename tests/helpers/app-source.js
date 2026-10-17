const fs = require('node:fs');
const path = require('node:path');

// Existing DOM unit tests run synchronously in vm contexts. Flatten the actual
// modules for that harness; native imports and the browser module graph have
// separate integration coverage. No business logic is duplicated here.
function readAppSource(only = null) {
    const directory = path.join(__dirname, '../../static/js/modules');
    const files = only ? ['store', 'lifecycle', ...only] : ['store', 'lifecycle', 'ad', 'ui', 'navigation', 'auth', 'router',
        'schedule-editor-model', 'schedule-editor-form', 'schedule-editor-gestures', 'schedule-editor', 'schedule-gestures', 'schedule-menu', 'schedule', 'home', 'exams', 'calendar', 'grades', 'evaluation',
        'announcements', 'feedback', 'member', 'service'];
    let source = `
globalThis.AbortController ||= class {
    constructor() {
        const listeners = new Set();
        this.signal = { aborted: false,
            addEventListener(type, fn) { listeners.add(fn); },
            removeEventListener(type, fn) { listeners.delete(fn); } };
        this.abort = reason => {
            if (this.signal.aborted) return;
            this.signal.aborted = true; this.signal.reason = reason;
            for (const fn of listeners) fn();
        };
    }
};
globalThis.DOMException ||= class extends Error {
    constructor(message, name) { super(message); this.name = name; }
};
`;
    for (const name of files) {
        source += '\n' + fs.readFileSync(path.join(directory, `${name}.js`), 'utf8')
            .replace(/^import .*;\n/gm, '')
            .replace(/^export /gm, '')
            .replace(/\bresources\b/g, `${name.replaceAll('-', '_')}Resources`);
    }
    source += `
for (const key of Object.keys(state)) Object.defineProperty(globalThis, key, {
    configurable: true, get: () => state[key], set: value => { state[key] = value; },
});
`;
    if (only) return source;
    source += `
registerPage('home', { mount: mountHome, unmount: unmountHome });
registerPage('schedule', { mount: mountSchedule, unmount: unmountSchedule });
registerPage('grades', { mount: mountGrades, unmount: unmountGrades });
registerPage('evaluation', { mount: mountEvaluation, unmount: unmountEvaluation });
registerPage('feedback', { mount: mountFeedback, unmount: unmountFeedback });
registerPage('service-status', { mount: mountService, unmount: unmountService });
registerPage('member', { mount: mountMember, unmount: unmountMember });
registerModalCleanup('exams-modal', unmountExams);
registerModalCleanup('calendar-export-modal', unmountCalendar);
if (typeof document?.addEventListener === 'function') {
    initializeUI(); initializeAuth();
    document.addEventListener('DOMContentLoaded', initializeNavigation);
}
`;
    return source;
}

module.exports = { readAppSource, readDomainSource: name => readAppSource([name]) };
