function readCurrentWeek() {
    try { return parseInt((globalThis.window?.localStorage || (typeof document === 'undefined' ? null : globalThis.localStorage))?.getItem('current_week')) || 1; }
    catch { return 1; }
}

const listeners = new Set();
const initialState = {
    currentWeek: readCurrentWeek(),
    currentUsername: null,
    currentMemberStatus: null,
    shortcutApiPlainKey: '',
    shortcutApiHasKey: false,
    loginStatusPromise: null,
    loginStatusResult: null,
    cachedSchedule: null,
    currentScheduleMap: new Map(),
    scheduleCourseId: 0,
    scheduleRevision: 0,
    scheduleSemesterKey: null,
    scheduleOwnerToken: null,
    personalScheduleNotices: [],
    cachedExams: null,
    cachedScheduleExams: [],
    scheduleExamsStale: false,
    semesterStart: null,
    academicCacheUsername: null,
    academicCacheGeneration: 0,
    calendarExportKind: null,
    calendarExportData: null,
    calendarExportAccount: '',
    isGuestMode: false,
    temporarySessionExpiresAt: null,
    temporarySessionTimer: null,
    temporaryReloginPromptShown: false,
    headerAdImpressionTracked: false,
    uiModalState: {
    activeModal: null,
    returnFocus: null,
    confirmationResolve: null,
},
    passwordDisclaimerReturnToLogin: false,
    countdownTimer: null,
    nextCountdownTimer: null,
    userIsFreshman: false,
    otherMajorScheduleData: null,
    gradeData: {},
    omSelected: { grade: null, major: null, class_num: null },
    scheduleSwipeTransition: null,
    scheduleSwipeTransitionTimer: null,
    scheduleHeightAnimation: null,
    suppressScheduleSwipeClick: false,
    scheduleSwipeFrame: null,
    scheduleSwipePendingEvent: null,
    scheduleQueuedSwipe: 0,
    historicalScheduleRequestId: 0,
    gradesReturnFocus: null,
    _examSessions: null,
    unevaluatedCoursesData: [],
    announcementItems: [],
    announcementDialogIndex: 0,
    _currentPayMemberType: null,
    _withdrawAvailable: 0,
    currentPage: null,
    user: null,
};
export const state = new Proxy(initialState, {
    set(target, key, value) {
        if (Object.is(target[key], value)) return true;
        target[key] = value;
        if (key === 'currentUsername') target.user = value ? { ...(target.user || {}), username: value } : null;
        if (key === 'user') target.currentUsername = value?.username || null;
        for (const listener of listeners) listener(state, key);
        return true;
    },
});
export const store = {
    getState: () => state,
    setState(patch) { Object.assign(state, patch); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
};
