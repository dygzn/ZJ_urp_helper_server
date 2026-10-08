import { coursePeriodSelection } from './schedule-editor-model.js';
// One lesson range determines both clocks, using the user's campus timetable.
export function mountScheduleEditorTimes(form,resources,getPeriods) {
    const fields=form.elements;
    let previous={section:1,duration:1};
    const update=event=>{
        const periods=getPeriods();
        const section=Math.max(1,Math.min(periods.length,Number(fields.start_section.value) || 1));
        let end=Math.max(section,Math.min(periods.length,Number(fields.end_section.value) || section));
        if(event?.target.name==='start_section')end=Math.min(periods.length,section+previous.duration-1);
        fields.start_section.value=String(section);fields.end_section.value=String(end);
        for(const option of fields.end_section.options)option.disabled=Number(option.value)<section;
        const date=fields.start_date.value;
        fields.start_at.value=date?`${date}T${periods[section-1].start}`:'';
        fields.end_at.value=date?`${date}T${periods[end-1].end}`:'';
        previous={section,duration:end-section+1};
    };
    const render=()=>{
        const periods=getPeriods();
        const absolute=value=>value?`${value}:00+08:00`:'';
        const span=coursePeriodSelection({start_at:absolute(fields.start_at.value),end_at:absolute(fields.end_at.value)},periods);
        fields.start_date.value=fields.start_at.value.slice(0,10);
        for(const [name,edge] of [['start_section','start'],['end_section','end']]){
            fields[name].replaceChildren(...periods.map((period,i)=>{const option=form.ownerDocument.createElement('option');option.value=String(i+1);option.textContent=`${i+1} · ${period[edge]}`;return option;}));
        }
        fields.start_section.value=String(span.section);fields.end_section.value=String(span.section+span.duration-1);
        update();
    };
    for(const name of ['start_date','start_section','end_section'])resources.listen(fields[name],'input',update);
    return {render};
}
