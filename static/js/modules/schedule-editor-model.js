// 时间只按中国时区解释；网格位置只是编辑辅助，不改写实际钟点。
export function chinaDateTime(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Date(date.getTime()+8*3600000).toISOString().slice(0,16) : '';
}
export function slotDate(week, day, semesterStart) {
    const date = new Date(`${semesterStart}T00:00:00Z`);
    if (!Number.isFinite(date.getTime())) return '';
    date.setUTCDate(date.getUTCDate()+(week-1)*7+day-1);
    return date.toISOString().slice(0,10);
}
export function periodSpanTimes(week, day, section, duration, semesterStart, periodTimes) {
    const date=slotDate(week,day,semesterStart);
    const start=periodTimes[section-1]?.start, end=periodTimes[section+duration-2]?.end;
    if (!date || !start || !end) return null;
    return {start_at:`${date}T${start}:00+08:00`,end_at:`${date}T${end}:00+08:00`};
}
export function courseTemplateOptions(schedule) {
    const options = new Map();
    for (const courses of Object.values(schedule || {})) for (const course of courses || []) {
        if (course.kind==='exam' || course.draft || !course.event_id || !course['课程名']) continue;
        const key=JSON.stringify([course['课程号'] || '',course['课程名'],course['教师'] || '',course['位置'] || course['教室'] || '',course.extra_fields || []]);
        if (!options.has(key)) options.set(key,course);
    }
    return [...options.values()];
}
export function applyCourseTemplate(draft, template) {
    return {...draft, name:template['课程名'] || '',classroom:template['位置'] || template['教室'] || '',
        template_event_id:template.event_id,extra_fields:JSON.parse(JSON.stringify(template.extra_fields || []))};
}
export function resizeDuration(section,endSection) { return Math.max(1,Math.min(10-section+1,endSection-section+1)); }
export function positionToSlot({x,y},geometry) {
    const col=geometry.columns.find(col=>x>=col.left && x<=col.right && y>=col.top && y<=col.bottom);
    if (!col) return null;
    return {day:col.day,section:Math.min(geometry.rows,Math.max(1,Math.floor((y-col.top)/(col.bottom-col.top)*geometry.rows)+1))};
}
export function splitCourseByDay(course) {
    const begin=chinaDateTime(course.start_at), finish=chinaDateTime(course.end_at);
    if (!begin || !finish || finish<=begin) return [];
    const parts=[];let date=begin.slice(0,10);const endDate=finish.slice(0,10);
    const minute=s=>Number(s.slice(11,13))*60+Number(s.slice(14,16));
    for (let i=0;date<=endDate && i<183;i++) {
        const startMinute=date===begin.slice(0,10)?minute(begin):0;
        const endMinute=date===endDate?minute(finish):1440;
        if (endMinute>startMinute) parts.push({date,startMinute,endMinute,raw:course});
        const next=new Date(`${date}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);date=next.toISOString().slice(0,10);
    }
    return parts;
}
export function exactCoursesForWeek(source,week,semesterStart,periodTimes) {
    const lower=slotDate(week,1,semesterStart),upper=slotDate(week,7,semesterStart);
    const result=[];
    const minutes=clock=>Number(clock.split(':')[0])*60+Number(clock.split(':')[1]);
    for (const courses of Object.values(source || {})) for (const course of courses || []) {
        if (!course.start_at || !course.end_at) continue;
        for (const segment of splitCourseByDay(course)) {
            if (segment.date<lower || segment.date>upper) continue;
            const rows=[];
            periodTimes.forEach((time,i)=>{if(segment.startMinute<minutes(time.end)&&segment.endMinute>minutes(time.start))rows.push(i+1);});
            result.push({raw:course,day:new Date(`${segment.date}T00:00:00Z`).getUTCDay() || 7,
                section:rows[0] || null,duration:rows.length?rows.at(-1)-rows[0]+1:0,date:segment.date});
        }
    }
    return result;
}
export function courseClockLabel(course) {
    const start=chinaDateTime(course.start_at),end=chinaDateTime(course.end_at);
    if (!start || !end) return '';
    return start.slice(0,10)===end.slice(0,10) ? `${start.slice(11)}–${end.slice(11)}`
        : `${start.slice(5,10)} ${start.slice(11)} 至 ${end.slice(5,10)} ${end.slice(11)}`;
}
export function shiftCourseTimes(course,slotTimes) {
    const duration=new Date(course.end_at).getTime()-new Date(course.start_at).getTime();
    return {...slotTimes,end_at:new Date(new Date(slotTimes.start_at).getTime()+duration).toISOString()};
}
export function courseDropTimes(course,week,slot,semesterStart,periodTimes) {
    const precise=course.source==='custom' || course.time_mode==='precise' || (!course.time_mode && !!course.version);
    const span=periodSpanTimes(week,slot.day,slot.section,precise?1:Math.max(1,Number(course['节数']) || 1),semesterStart,periodTimes);
    return span && precise?shiftCourseTimes(course,span):span;
}
export function hasCourseTimeConflict(course,courses,date,periodTimes) {
    const interval=item=>{
        const raw=item.raw || {};
        if(raw.start_at && raw.end_at)return [new Date(raw.start_at).getTime(),new Date(raw.end_at).getTime()];
        const parts=item.kind==='exam'?item.time?.split('-'):[periodTimes[item.section-1]?.start,periodTimes[item.section+item.duration-2]?.end];
        return parts?.[0] && parts[1]?[new Date(`${date}T${parts[0]}:00+08:00`).getTime(),new Date(`${date}T${parts[1]}:00+08:00`).getTime()]:null;
    };
    const own=interval(course);
    return !!own && courses.some(other=>{
        if(other===course || (course.raw && other.raw===course.raw))return false;
        const span=interval(other);return span && own[0]<span[1] && own[1]>span[0];
    });
}
export function resizeScheduleSpan(span,edge,section) {
    const end=span.section+span.duration-1;
    if(edge==='start') {const start=Math.max(1,Math.min(end,section));return {section:start,duration:end-start+1};}
    return {section:span.section,duration:Math.max(1,Math.min(10,section)-span.section+1)};
}
export function scheduleSeriesCourses(course,schedule) {
    const unique=new Map();
    for(const item of Object.values(schedule || {}).flat())if(item.event_id && item.series_id===course?.series_id)unique.set(item.event_id,item);
    return [...unique.values()];
}
export function scheduleRepeatSummary(course,schedule,action='edit') {
    if(!course)return '全部周：第1–25周，每周一次，共25次';
    const targets=scheduleSeriesCourses(course,schedule).filter(item=>action!=='restore' || item.version>0);
    const affected=action==='restore' && course.affected_weeks?course.affected_weeks:targets.map(item=>item.original_week);
    const weeks=[...new Set(affected)].sort((a,b)=>a-b),runs=[];
    for(let i=0;i<weeks.length;i++){const first=weeks[i];while(i+1<weeks.length && weeks[i+1]===weeks[i]+1)i++;runs.push(first===weeks[i]?String(first):`${first}–${weeks[i]}`);}
    return `全部周：第${runs.join('、') || course.original_week}周，共${affected.length}次，仅此上课时段`;
}
export function projectScheduleMutation(course,payload,schedule,semesterStart) {
    if(payload.scope!=='all')return [{...payload,event_id:course?.event_id}];
    const targets=course?scheduleSeriesCourses(course,schedule).filter(item=>payload.action!=='restore' || item.version>0):Array.from({length:25},(_,i)=>({original_week:i+1}));
    const anchor=course?course.original_week:Math.floor((new Date(payload.start_at)-new Date(`${semesterStart}T00:00:00+08:00`))/(7*86400000))+1;
    return targets.map(target=>({event_id:target.event_id,课程名:payload.name || course?.['课程名'] || '新增课程',
        start_at:new Date(new Date(payload.start_at).getTime()+(target.original_week-anchor)*7*86400000).toISOString(),
        end_at:new Date(new Date(payload.end_at).getTime()+(target.original_week-anchor)*7*86400000).toISOString()}));
}
export function findScheduleConflicts(course,payload,schedule,semesterStart,exams=[]) {
    if(!payload.start_at || !payload.end_at)return [];
    const proposed=projectScheduleMutation(course,payload,schedule,semesterStart);
    const removed=new Set(proposed.map(item=>item.event_id).filter(Boolean));
    const candidates=Object.values(schedule || {}).flat().filter(item=>!removed.has(item.event_id));
    candidates.push(...exams);
    const conflicts=new Map();
    for(const span of proposed)for(const other of candidates){
        if(!other.start_at || !other.end_at)continue;
        if(new Date(span.start_at)<new Date(other.end_at) && new Date(span.end_at)>new Date(other.start_at))
            conflicts.set(other.event_id || JSON.stringify([other['课程名'],other.start_at,other.end_at]),other);
    }
    return [...conflicts.values()];
}
export function courseResizeTimes(course,week,span,semesterStart,periodTimes) {
    const clocks=periodSpanTimes(week,span.day,span.section,span.duration,semesterStart,periodTimes);
    if(!clocks)return null;
    return span.edge==='start'?{start_at:clocks.start_at,end_at:course.end_at}:{start_at:course.start_at,end_at:clocks.end_at};
}
