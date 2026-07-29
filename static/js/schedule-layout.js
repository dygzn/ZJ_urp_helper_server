function setScheduleWeekendVisibility(hasWeekend, scheduleGrid, scheduleHeader) {
    const hideWeekend = !hasWeekend;
    scheduleGrid.classList.toggle('no-weekend', hideWeekend);
    scheduleHeader.classList.toggle('no-weekend', hideWeekend);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { setScheduleWeekendVisibility };
}
