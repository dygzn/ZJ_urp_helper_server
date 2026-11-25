// Refresh the versioned entry after removing cross-major schedule modules and state.
import * as scheduleEditor from './modules/schedule-editor.js?v=20261124-ux';
import { state, store } from './modules/store.js';
import * as auth from './modules/auth.js?v=20261124-ux';
import * as router from './modules/router.js?v=20261124-ux';
import * as schedule from './modules/schedule.js';
import * as scheduleGestures from './modules/schedule-gestures.js';
import * as grades from './modules/grades.js?v=20261124-ux';
import * as home from './modules/home.js?v=20261124-ux';
import * as exams from './modules/exams.js?v=20261124-ux';
import * as calendar from './modules/calendar.js';
import * as ui from './modules/ui.js?v=20261124-ux';
import * as navigation from './modules/navigation.js?v=20261124-ux';
import * as announcements from './modules/announcements.js';
import * as miniapp from './modules/miniapp.js';
import * as feedback from './modules/feedback.js?v=20261124-ux';
import * as member from './modules/member.js?v=20261124-ux';
import * as evaluation from './modules/evaluation.js?v=20261124-ux';
import * as service from './modules/service.js';
import * as lab from './modules/lab.js?v=20261124-ux';
import * as ad from './modules/ad.js';

const domains = { auth, router, schedule: { ...scheduleGestures, ...schedule, ...scheduleEditor }, grades, home, exams, calendar, ui, navigation,
    announcements, miniapp, feedback, member, evaluation, service, lab, ad };

// Modules communicate through imports. This bridge serves existing HTML attributes
// and integrations; new HTML may use URP.auth.openLogin(), URP.router.switchPage(), etc.
window.URP = { ...domains, store, auth: { ...auth, openLogin: auth.showLoginModal } };
for (const domain of Object.values(domains)) {
    for (const [name, action] of Object.entries(domain)) {
        if (typeof action !== 'function' || /^(mount|unmount|initialize|register)/.test(name)) continue;
        window[name] = (...args) => {
            const result = action(...args);
            return result?.catch ? result.catch(error => {
                if (error.name !== 'AbortError') throw error;
            }) : result;
        };
    }
}

router.registerPage('home', { mount: home.mountHome, unmount: home.unmountHome });
router.registerPage('schedule', { mount: schedule.mountSchedule, unmount: schedule.unmountSchedule });
router.registerPage('grades', { mount: grades.mountGrades, unmount: grades.unmountGrades });
router.registerPage('evaluation', { mount: evaluation.mountEvaluation, unmount: evaluation.unmountEvaluation });
router.registerPage('service-status', { mount: service.mountService, unmount: service.unmountService });
router.registerPage('feedback', { mount: feedback.mountFeedback, unmount: feedback.unmountFeedback });
router.registerPage('member', { mount: member.mountMember, unmount: member.unmountMember });
router.registerPage('lab', { mount: lab.mountLab, unmount: lab.unmountLab });

ui.registerModalCleanup('exams-modal', exams.unmountExams);
ui.registerModalCleanup('calendar-export-modal', calendar.unmountCalendar);

function start() {
    ui.initializeUI();
    auth.initializeAuth();
    navigation.initializeNavigation();
    auth.getDeviceId();
    ad.initializeHeaderAd();
    auth.capturePendingInvitationToken();
    auth.sanitizeIndexUrl();
    state.isGuestMode = true;
    announcements.initializeAnnouncements();
    auth.checkBindStatus().finally(() => miniapp.initializeMiniAppPromo());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
