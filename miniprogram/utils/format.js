const WEEKDAY_LABELS = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateOnly(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return timestamp;
}

function toUtcDayTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  }
  return parseDateOnly(value);
}

function getCurrentWeek(semesterStart, now = new Date()) {
  const start = parseDateOnly(semesterStart);
  const current = toUtcDayTimestamp(now);
  if (start === null || current === null || current < start) return 1;
  return Math.floor((current - start) / (7 * DAY_MS)) + 1;
}

function asNumber(value, fallback = 0) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}

function groupSchedule(schedule) {
  const groups = new Map();
  Object.keys(schedule || {}).forEach(weekKey => {
    const courses = Array.isArray(schedule[weekKey]) ? schedule[weekKey] : [];
    courses.forEach(course => {
      const day = asNumber(course['星期'] ?? course.day, 0);
      if (day < 1 || day > 7) return;
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(Object.assign({}, course, {
        courseName: course.courseName || course['课程名'] || '',
        location: course.location || course['位置'] || course['上课地点'] || '',
        period: course.period || course['节次'] || '',
        duration: course.duration || course['节数'] || '',
      }));
    });
  });

  return Array.from(groups.entries())
    .sort(([left], [right]) => left - right)
    .map(([day, courses]) => ({
      day,
      label: WEEKDAY_LABELS[day] || `星期${day}`,
      courses: courses.sort(
        (left, right) =>
          asNumber(left['节次'] ?? left.period, 0) -
          asNumber(right['节次'] ?? right.period, 0),
      ),
    }));
}

function formatScore(value) {
  return value === null || value === undefined || String(value).trim() === ''
    ? '--'
    : String(value);
}

function formatExam(exam) {
  const source = exam || {};
  return Object.assign({}, source, {
    time: source.time || source['考试时间'] || '',
    location: source.location || source['位置'] || '',
    seat: source.seat || source['座位号'] || '',
  });
}

module.exports = {
  getCurrentWeek,
  groupSchedule,
  formatScore,
  formatExam,
};
