// The editor shows one date. Existing saved spans retain their real end date.
export function mountScheduleEditorTimes(form,resources) {
    let previous=null,endDayOffset=0;
    const fields=form.elements;
    const dayNumber=date=>new Date(date+'T00:00:00Z').getTime()/86400000;
    const render=()=>{
        const start=fields.start_at.value,end=fields.end_at.value;
        fields.start_date.value=start.slice(0,10);fields.start_clock.value=start.slice(11,16);fields.end_clock.value=end.slice(11,16);
        endDayOffset=start && end?Math.max(0,Math.round(dayNumber(end.slice(0,10))-dayNumber(start.slice(0,10)))):0;
        previous=start && end && end>start?{start,end}:null;
    };
    const sync=event=>{
        const date=fields.start_date.value;
        const start=date && fields.start_clock.value?`${date}T${fields.start_clock.value}`:'';
        const movingStart=['start_date','start_clock'].includes(event.target.name);
        if(movingStart && previous && start && start!==previous.start){
            const duration=new Date(previous.end+'+08:00')-new Date(previous.start+'+08:00');
            const next=new Date(new Date(start+'+08:00').getTime()+duration+8*3600000).toISOString().slice(0,16);
            if(endDayOffset>0 || next.slice(0,10)===date){
                fields.end_clock.value=next.slice(11);endDayOffset=Math.max(0,Math.round(dayNumber(next.slice(0,10))-dayNumber(date)));
            }
        }
        const endDate=date?new Date((dayNumber(date)+endDayOffset)*86400000).toISOString().slice(0,10):'';
        fields.start_at.value=start;fields.end_at.value=endDate && fields.end_clock.value?`${endDate}T${fields.end_clock.value}`:'';
        if(start && fields.end_at.value>start)previous={start,end:fields.end_at.value};
    };
    for(const field of ['start_date','start_clock','end_clock'])resources.listen(fields[field],'input',sync);
    return {render};
}
