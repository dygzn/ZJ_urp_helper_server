// Visible date/clock fields compose the exact timestamps used by the existing API.
export function mountScheduleEditorTimes(form,resources) {
    let previous=null;
    const fields=form.elements;
    const render=()=>{
        const start=fields.start_at.value,end=fields.end_at.value;
        fields.start_date.value=start.slice(0,10);fields.start_clock.value=start.slice(11,16);
        fields.end_date.value=end.slice(0,10);fields.end_clock.value=end.slice(11,16);
        fields.cross_day.checked=!!end && start.slice(0,10)!==end.slice(0,10);
        form.querySelector('[data-editor-end-date]').hidden=!fields.cross_day.checked;
        fields.end_date.required=fields.cross_day.checked;
        previous=start && end && end>start?{start,end}:null;
    };
    const sync=event=>{
        const start=fields.start_date.value && fields.start_clock.value?`${fields.start_date.value}T${fields.start_clock.value}`:'';
        const movingStart=['start_date','start_clock'].includes(event.target.name);
        if(movingStart && previous && start && start!==previous.start){
            const duration=new Date(previous.end+'+08:00')-new Date(previous.start+'+08:00');
            const next=new Date(new Date(start+'+08:00').getTime()+duration+8*3600000).toISOString().slice(0,16);
            fields.end_date.value=next.slice(0,10);fields.end_clock.value=next.slice(11);
            fields.cross_day.checked=fields.end_date.value!==fields.start_date.value;
        }
        if(event.target.name==='cross_day' && fields.cross_day.checked && fields.start_date.value && fields.end_date.value<=fields.start_date.value){
            fields.end_date.value=new Date(new Date(fields.start_date.value+'T00:00:00Z').getTime()+86400000).toISOString().slice(0,10);
        }
        const endDate=fields.cross_day.checked?fields.end_date.value:fields.start_date.value;
        fields.start_at.value=start;
        fields.end_at.value=endDate && fields.end_clock.value?`${endDate}T${fields.end_clock.value}`:'';
        form.querySelector('[data-editor-end-date]').hidden=!fields.cross_day.checked;
        fields.end_date.required=fields.cross_day.checked;
        if(start && fields.end_at.value>start)previous={start,end:fields.end_at.value};
    };
    for(const field of ['start_date','start_clock','end_date','end_clock','cross_day'])resources.listen(fields[field],'input',sync);
    return {render};
}
