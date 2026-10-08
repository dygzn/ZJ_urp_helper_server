import { pageResources } from './lifecycle.js';
import { state } from './store.js';
import { displaySchedule, PERIOD_TIMES_DEFAULT, PERIOD_TIMES_FRESHMAN } from './schedule.js';
import { currentSemesterStartValue } from './calendar.js';
import { closeUiModal, showUiToast } from './ui.js';
import { mountScheduleEditorGestures, cancelScheduleEditingGesture } from './schedule-editor-gestures.js';
import { courseTemplateOptions, applyCourseTemplate, periodSpanTimes, chinaDateTime, courseClockLabel, courseDropTimes, courseResizeTimes, scheduleRepeatSummary, findScheduleConflicts, slotDate } from './schedule-editor-model.js';
import { mountScheduleEditorTimes } from './schedule-editor-form.js';
const resources = pageResources('schedule');
export const scheduleEditor = {epoch:0,cancelGestures:null,draft:null,dialog:null,scopeDialog:null,pending:false,course:null,returnFocus:null,times:null,conflict:null,undo:null,undoTimer:null};
export function canEditSchedule() { return !scheduleEditor.pending && !state.isGuestMode && !state.otherMajorScheduleData && !!currentSemesterStartValue(); }
export function resetScheduleEditor() {
    scheduleEditor.epoch++;
    clearScheduleUndo();
    scheduleEditor.cancelGestures?.();
    clearScheduleDraft();
    scheduleEditor.pending=false;scheduleEditor.course=null;scheduleEditor.returnFocus=null;
    scheduleEditor.dialog?.close();scheduleEditor.scopeDialog?.close();
    const form=scheduleEditor.dialog?.querySelector?.('form');
    form?.reset();
    form?.querySelector?.('[data-editor-fields]')?.replaceChildren();
    form?.querySelector?.('[name="template"]')?.replaceChildren();
    if(scheduleEditor.scopeDialog){
        scheduleEditor.scopeDialog._select=null;scheduleEditor.scopeDialog._proceed=null;
        const title=scheduleEditor.scopeDialog.querySelector?.('h2');if(title)title.textContent='选择生效范围';
        const desc=scheduleEditor.scopeDialog.querySelector?.('[data-scope-description]');if(desc)desc.textContent='';
    }
    document.getElementById('page-schedule')?.querySelector?.('.schedule-personal-notices')?.remove?.();
}
export function clearScheduleDraft() { scheduleEditor.draft=null; document.getElementById('page-schedule')?.classList?.remove('has-draft-evening'); document.querySelector?.('.schedule-course-draft')?.remove?.(); }
export function renderScheduleDraft() {
    const draft=scheduleEditor.draft;
    document.getElementById('page-schedule')?.classList?.toggle('has-draft-evening',!!draft && draft.section+draft.duration-1>=9 && draft.week===state.currentWeek);
    if (!draft) return;
    if (draft.week!==state.currentWeek || state.otherMajorScheduleData) {document.querySelector?.('.schedule-course-draft')?.remove?.();return;}
    const panel=document.querySelector('.schedule-week-panel.is-current');
    const column=panel?.querySelector(`[data-schedule-column-day="${draft.day}"]`);
    if (!column) return;
    let button=document.querySelector?.('.schedule-course-draft');
    const fresh=!button;
    if(fresh){button=document.createElement('button');button.type='button';button.className='schedule-course-draft';}
    button.setAttribute('aria-label',`新增课程，第${draft.section}至${draft.section+draft.duration-1}节，点击编辑，长按中间移动，长按上下箭头调整起止`);
    button.style.gridRow=`${draft.section} / span ${draft.duration}`;
    if(fresh) button.innerHTML='<span aria-hidden="true">＋</span><span>新增课程</span><span class="schedule-draft-drag-cue is-up" data-schedule-resize-edge="start" aria-hidden="true">↑</span><span class="schedule-draft-drag-cue is-down" data-schedule-resize-edge="end" aria-hidden="true">↓</span>';
    if(fresh) resources.listen(button,'click',()=>openScheduleCourseEditor({draft:scheduleEditor.draft,returnFocus:button}));column.append(button);
}
export function createScheduleDraft(slot) {
    if (scheduleEditor.pending) {showUiToast('正在保存课程，请稍候','info');return;}
    if (!canEditSchedule()) {showUiToast('请先确认登录与学期日期，再添加个人课程','info');return;}
    clearScheduleDraft();
    scheduleEditor.draft={week:state.currentWeek,...slot,duration:1};renderScheduleDraft();
}
export function addScheduleCourse() {createScheduleDraft({day:1,section:1});if(scheduleEditor.draft)openScheduleCourseEditor({draft:scheduleEditor.draft,returnFocus:document.getElementById('schedule-add-course')});}
function editorPeriods() {return state.userIsFreshman?PERIOD_TIMES_FRESHMAN:PERIOD_TIMES_DEFAULT;}
function restoreEditorFocus() {
    const target=scheduleEditor.returnFocus;
    if(target?.isConnected)target.focus({preventScroll:true});
    else document.getElementById('schedule-content')?.focus({preventScroll:true});
}
function rememberScheduleDraftForm() {
    const draft=scheduleEditor.draft,form=scheduleEditor.dialog?.querySelector('form');
    if(!draft || !form || scheduleEditor.course || scheduleEditor.pending)return;
    draft.values={name:form.elements.name.value,classroom:form.elements.classroom.value,start_at:form.elements.start_at.value+':00+08:00',end_at:form.elements.end_at.value+':00+08:00',
        mode:form.querySelector('[data-editor-template]').hidden?'custom':'existing',template_event_id:form.elements.template.value,
        extra_fields:[...form.querySelectorAll('.schedule-extra-row')].map(row=>({name:row.querySelector('input').value,value:row.querySelector('textarea').value}))};
}
function closeEditor() {rememberScheduleDraftForm();scheduleEditor.dialog?.close();restoreEditorFocus();}
function extraRow(field={name:'',value:''}) {
    const row=document.createElement('div');row.className='schedule-extra-row';
    row.innerHTML='<label>数据名<input name="extra-name" maxlength="60"></label><label>数据内容<textarea name="extra-value" maxlength="2000" rows="1"></textarea></label><button type="button" class="btn-secondary" aria-label="删除这项信息">删除</button>';
    resources.listen(row.querySelector('textarea'),'focus',()=>row.classList.add('is-expanded'));
    row.querySelector('input').value=field.name;row.querySelector('textarea').value=field.value;
    resources.listen(row.querySelector('button'),'click',()=>{row.remove();scheduleEditor.dialog.querySelector('[data-editor-add-field]').focus();});
    return row;
}
function setEditorValues(values) {
    const form=scheduleEditor.dialog.querySelector('form');
    form.elements.name.value=values.name || '';
    form.elements.classroom.value=values.classroom || '';
    form.elements.start_at.value=chinaDateTime(values.start_at);
    form.elements.end_at.value=chinaDateTime(values.end_at);
    scheduleEditor.times?.render();
    const fields=form.querySelector('[data-editor-fields]');fields.replaceChildren();
    for(const row of values.extra_fields || [])fields.append(extraRow(row));
}
function clearScheduleConflict() {
    scheduleEditor.conflict=null;
    const block=scheduleEditor.dialog?.querySelector?.('[data-editor-conflict]');if(block)block.hidden=true;
}
function updateScheduleEditorSummary() {
    const form=scheduleEditor.dialog?.querySelector('form');if(!form)return;
    form.querySelector('[data-editor-scope]').textContent=scheduleRepeatSummary(scheduleEditor.course,state.cachedSchedule);
    form.querySelector('[data-editor-source]').textContent=scheduleEditor.course?
        scheduleEditor.course.source==='custom'?'自定义课程':'教务课程 · 仅调整个人课表时间':
        form.querySelector('[data-editor-template]').hidden?'长按中间移动，上下边缘调整起止':'复用课程资料，时间以当前卡片为准，原课程保持不变';
}
function showScheduleConflicts(course,payload,inEditor,onProceed=null) {
    const exams=(state.cachedScheduleExams || []).flatMap(exam=>{
        const time=typeof parseCalendarExamTime==='function'?parseCalendarExamTime(exam.time):null;
        const date=slotDate(Number(exam.week),Number(exam.day),currentSemesterStartValue());
        return time && date?[{课程名:`${exam.course || '课程'}（考试）`,start_at:`${date}T${time.start}:00+08:00`,end_at:`${date}T${time.end}:00+08:00`}]:[];
    });
    const conflicts=findScheduleConflicts(course,payload,state.cachedSchedule,currentSemesterStartValue(),exams);
    if(!conflicts.length)return false;
    const text='与以下安排重叠：\n'+conflicts.slice(0,3).map(item=>`${item['课程名']} · ${chinaDateTime(item.start_at).slice(5,10)} ${courseClockLabel(item)}`).join('\n')
        +(conflicts.length>3?`\n另有${conflicts.length-3}项`:'')+'\n仍然保存会保留全部安排。';
    if(inEditor){
        scheduleEditor.conflict=payload.scope;
        const block=scheduleEditor.dialog.querySelector('[data-editor-conflict]');block.hidden=false;block.querySelector('p').textContent=text;
        block.querySelector('button').focus();
    }else{
        const dialog=scheduleEditor.scopeDialog;dialog.querySelector('h2').textContent='新时间与其他安排重叠';
        const block=dialog.querySelector('[data-scope-conflict]');block.hidden=false;block.textContent=text;
        dialog.querySelectorAll('[data-scope]').forEach(button=>button.hidden=true);
        const proceed=dialog.querySelector('[data-scope-proceed]');proceed.hidden=false;dialog._proceed=onProceed;
        dialog.showModal();dialog.querySelector('[data-scope-cancel]').focus();
    }
    return true;
}
export function clearScheduleUndo() {
    if(scheduleEditor.undoTimer!==null)resources.clearTimeout(scheduleEditor.undoTimer);
    scheduleEditor.undoTimer=null;scheduleEditor.undo=null;
    document.getElementById('schedule-undo-notice')?.remove?.();
}
function showScheduleUndo(undo) {
    clearScheduleUndo();
    if(undo.revision!==state.scheduleRevision)return;
    const notice=document.createElement('div');notice.id='schedule-undo-notice';notice.className='schedule-undo-notice';notice.setAttribute('role','status');
    const text=document.createElement('span');text.textContent='课表已更新，可撤销刚才的操作';
    const button=document.createElement('button');button.type='button';button.className='btn-secondary';button.dataset.scheduleUndo='';button.textContent='撤销';
    notice.append(text,button);document.getElementById('page-schedule').querySelector('.schedule-container').prepend(notice);
    scheduleEditor.undo={...undo,epoch:scheduleEditor.epoch,owner:state.scheduleOwnerToken,semester:state.scheduleSemesterKey};
    resources.listen(button,'click',undoScheduleEdit);
    scheduleEditor.undoTimer=resources.setTimeout(clearScheduleUndo,12000);
}
export function undoScheduleEdit() {
    const undo=scheduleEditor.undo;if(!undo || scheduleEditor.pending)return;
    if(undo.epoch!==scheduleEditor.epoch || undo.owner!==state.scheduleOwnerToken || undo.semester!==state.scheduleSemesterKey || undo.revision!==state.scheduleRevision){
        clearScheduleUndo();showUiToast('课表已有后续变化，无法撤销之前的操作','info');return;
    }
    return writeSchedule('/api/schedule/undo','POST',{token:undo.token,revision:undo.revision});
}
export function openScheduleCourseEditor({draft=null,course=null,returnFocus=null}) {
    if (!canEditSchedule())return;
    const dialog=scheduleEditor.dialog;if(!dialog)return;
    closeUiModal(document.getElementById('course-detail-modal'));
    scheduleEditor.course=course;scheduleEditor.returnFocus=returnFocus;scheduleEditor.pending=false;
    const form=dialog.querySelector('form');
    form.reset();form.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=false);form.querySelector('[data-editor-error]').textContent='';
    const mode=form.querySelector('[data-editor-mode]');mode.hidden=!!course;
    const options=courseTemplateOptions(state.cachedSchedule);
    const select=form.elements.template;select.replaceChildren();
    const empty=document.createElement('option');empty.value='';empty.textContent=options.length?'请选择已有课程':'暂无已有课程，可选择自定义';select.append(empty);
    for(const item of options){const option=document.createElement('option');option.value=item.event_id || '';option.textContent=[item['课程名'],item['教师'],item['位置'] || item['教室']].filter(Boolean).join(' · ');select.append(option);}
    const clocks=draft?periodSpanTimes(draft.week,draft.day,draft.section,draft.duration,currentSemesterStartValue(),editorPeriods()):{};
    setEditorValues(course?{name:course['课程名'],classroom:course['位置'] || course['教室'],start_at:course.start_at,end_at:course.end_at,extra_fields:course.extra_fields || []}:draft?.values || {...clocks,name:'',classroom:'',extra_fields:[]});
    const existing=!course && draft?.values?.mode==='existing';
    form.querySelector('[data-editor-template]').hidden=!existing;
    if(existing)form.elements.template.value=draft.values.template_event_id || '';
    form.querySelectorAll('[data-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mode===(existing?'existing':'custom'))));
    clearScheduleConflict();updateScheduleEditorSummary();
    dialog.querySelector('h2').textContent=course?course.source==='custom'?'编辑课程':'修改课程时间':'新增课程';
    form.querySelector('[data-editor-delete]').hidden=!course || course.source!=='custom';
    form.querySelector('[data-editor-restore]').hidden=!course || course.source!=='urp' || !course.version;
    form.querySelector('.schedule-course-edit-actions').hidden=!course || (course.source!=='custom' && !course.version);
    if(course?.source==='urp'){form.elements.name.disabled=true;form.elements.classroom.disabled=true;form.querySelector('[data-editor-add-field]').disabled=true;}
    if (!dialog.open)dialog.showModal();(course?.source==='urp'?form.elements.start_clock:form.elements.name).focus();
}
function inputPayload(scope) {
    const form=scheduleEditor.dialog.querySelector('form');
    if(!form.reportValidity())return null;
    const start=form.elements.start_at.value,end=form.elements.end_at.value;
    if(!start || !end || end<=start){form.querySelector('[data-editor-error]').textContent='结束时间须晚于开始时间';return null;}
    const rows=[...form.querySelectorAll('.schedule-extra-row')].map(row=>({name:row.querySelector('input').value.trim(),value:row.querySelector('textarea').value.trim()})).filter(row=>row.name || row.value);
    if(rows.some(row=>!row.name || !row.value)){form.querySelector('[data-editor-error]').textContent='请完整填写每项的数据名和内容，或删除未使用的信息';return null;}
    return {scope,revision:state.scheduleRevision,week:scheduleEditor.draft?.week || state.currentWeek,
        name:form.elements.name.value.trim(),classroom:form.elements.classroom.value.trim(),time_mode:'precise',
        start_at:`${start}:00+08:00`,end_at:`${end}:00+08:00`,extra_fields:rows,
        ...(form.querySelector('[data-editor-template]').hidden || !form.elements.template.value?{}:{template_event_id:form.elements.template.value})};
}
async function submitEditor(scope,confirmed=false) {
    const payload=inputPayload(scope);if(!payload)return;
    const course=scheduleEditor.course;
    if(!confirmed && showScheduleConflicts(course,payload,true))return;
    const path=course?`/api/schedule/${course.source==='custom'?'personal':'overrides'}/${encodeURIComponent(course.event_id)}`:'/api/schedule/personal';
    await writeSchedule(path,course?(course.source==='custom'?'PATCH':'PUT'):'POST',payload);
}
export async function writeSchedule(path,method,payload) {
    if(scheduleEditor.pending)return;
    payload={...payload, ...(state.scheduleSemesterKey?{semester_key:state.scheduleSemesterKey}:{}), ...(state.scheduleOwnerToken?{owner_token:state.scheduleOwnerToken}:{})};
    scheduleEditor.pending=true;
    const operation=resources.capture(),generation=state.academicCacheGeneration,epoch=scheduleEditor.epoch;
    const dialog=scheduleEditor.dialog;
    const controls=[...(dialog?.querySelectorAll('button,input,textarea,select') || [])].map(el=>({el,disabled:el.disabled}));
    controls.forEach(({el})=>el.disabled=true);
    try {
        const response=await operation.wait(resources.api.request(path,{method,body:JSON.stringify(payload)}));
        const result=await operation.wait(response.json());
        if(generation!==state.academicCacheGeneration || epoch!==scheduleEditor.epoch)return;
        if(!result.success)throw new Error(result.message || '保存失败，请重试');
        clearScheduleUndo();state.cachedSchedule=result.data.schedule;state.scheduleRevision=result.data.revision;
        if(result.data.semester_key)state.scheduleSemesterKey=result.data.semester_key;
        state.personalScheduleNotices=result.data.notices || [];state.calendarExportData=null;
        if(method==='POST' && path!=='/api/schedule/undo')clearScheduleDraft();displaySchedule(state.cachedSchedule);
        scheduleEditor.dialog?.close();scheduleEditor.scopeDialog?.close();restoreEditorFocus();
        showUiToast(result.message || '课程已保存','success');
        if(result.data.undo)showScheduleUndo(result.data.undo);
    } catch(error) {
        if(error.name==='AbortError' || generation!==state.academicCacheGeneration || epoch!==scheduleEditor.epoch)return;
        if(dialog?.open)dialog.querySelector('[data-editor-error]').textContent=error.message;
        else showUiToast(error.message,'error');
    } finally {
        if(operation.isActive() && generation===state.academicCacheGeneration && epoch===scheduleEditor.epoch){
            scheduleEditor.pending=false;controls.forEach(({el,disabled})=>el.disabled=disabled);
        }
    }
}
export function promptScheduleScope(title,onSelect,description='',course=null,action='edit') {
    if(scheduleEditor.pending)return;
    const dialog=scheduleEditor.scopeDialog;if(!dialog)return;
    dialog.querySelector('h2').textContent=title;
    dialog.querySelector('[data-scope-description]').textContent=description+`\n仅本周：只修改这一次。\n${scheduleRepeatSummary(course,state.cachedSchedule,action)}。取消不保存。`;
    dialog.querySelector('[data-scope-conflict]').hidden=true;dialog.querySelector('[data-scope-proceed]').hidden=true;
    dialog.querySelectorAll('[data-scope]').forEach(button=>button.hidden=false);
    dialog._select=onSelect;if(!dialog.open)dialog.showModal();dialog.querySelector('[data-scope="week"]').focus();
}
export function moveScheduleCourse(course,slot) {
    const times=courseDropTimes(course,state.currentWeek,slot,currentSemesterStartValue(),editorPeriods());
    if(!times){showUiToast('此位置无法容纳完整课程，请在详情中修改精确时间','info');return;}
    return changeScheduleCourseTimes(course,times);
}
export function resizeScheduleCourse(course,span) {
    const times=courseResizeTimes(course,state.currentWeek,span,currentSemesterStartValue(),editorPeriods());
    if(!times || new Date(times.end_at)<=new Date(times.start_at)){showUiToast('结束时间须晚于开始时间，请在编辑器中调整','info');return;}
    return changeScheduleCourseTimes(course,times);
}
function changeScheduleCourseTimes(course,times) {
    promptScheduleScope(`调整 ${course['课程名']} 的时间`,scope=>{
        const path=`/api/schedule/${course.source==='custom'?'personal':'overrides'}/${encodeURIComponent(course.event_id)}`;
        const payload={scope,revision:state.scheduleRevision,week:state.currentWeek,...times,
            name:course['课程名'],classroom:course['教室'] || '',time_mode:course.source==='urp' && course.time_mode==='period'?'period':'precise',extra_fields:course.extra_fields || []};
        if(showScheduleConflicts(course,payload,false,()=>writeSchedule(path,course.source==='custom'?'PATCH':'PUT',payload)))return;
        return writeSchedule(path,course.source==='custom'?'PATCH':'PUT',payload);
    },`原时间：${chinaDateTime(course.start_at).replace('T',' ')} 至 ${chinaDateTime(course.end_at).replace('T',' ')}。\n新时间：${chinaDateTime(times.start_at).replace('T',' ')} 至 ${chinaDateTime(times.end_at).replace('T',' ')}。`,course);
}
function applyScheduleDraftPlacement(draft,change={}) {
    if(draft.values){
        const times=change.mode==='move'?courseDropTimes({...draft.values,source:'custom'},draft.week,draft,currentSemesterStartValue(),editorPeriods()):
            courseResizeTimes(draft.values,draft.week,{...draft,edge:change.edge},currentSemesterStartValue(),editorPeriods());
        if(!times || new Date(times.end_at)<=new Date(times.start_at)){showUiToast('结束时间须晚于开始时间，请在编辑器中调整','info');return;}
        draft.values={...draft.values,...times};
    }
    scheduleEditor.draft=draft;renderScheduleDraft();
}
export function appendScheduleEditActions(body,course,source) {
    if(!canEditSchedule() || !course.raw?.event_id || course.kind==='exam')return;
    const row=document.createElement('div');row.className='schedule-course-edit-actions';
    const origin=document.createElement('p');origin.className='schedule-editor-help';origin.textContent=course.raw.source==='custom'?'自定义课程':'教务课程 · 时间调整仅影响个人课表';body.append(origin);
    const button=document.createElement('button');button.type='button';button.className='btn-secondary';
    button.textContent=course.raw.source==='custom'?'编辑课程':'修改时间';
    resources.listen(button,'click',()=>openScheduleCourseEditor({course:course.raw,returnFocus:source}));row.append(button);body.append(row);
}
export function renderPersonalScheduleNotices() {
    const page=document.getElementById('page-schedule');
    if (!page?.querySelector || typeof document.createElement!=='function')return;
    let block=page.querySelector('.schedule-personal-notices');
    if(!state.personalScheduleNotices.length || state.otherMajorScheduleData){block?.remove();return;}
    if(!block){block=document.createElement('div');block.className='schedule-personal-notices';page.querySelector('.schedule-container').prepend(block);}
    block.replaceChildren();
    for(const notice of state.personalScheduleNotices){
        const row=document.createElement('p');row.textContent=`${notice.name}：${notice.message} `;
        const button=document.createElement('button');button.type='button';button.className='btn-secondary';button.textContent='清除时间调整';
        resources.listen(button,'click',()=>promptScheduleScope('清除时间调整的范围',scope=>writeSchedule(`/api/schedule/overrides/${encodeURIComponent(notice.event_id)}`,'DELETE',{scope,week:state.currentWeek,revision:state.scheduleRevision}),'',notice.course,'restore'));
        row.append(button);block.append(row);
    }
}
export function mountScheduleEditor() {
    if(scheduleEditor.dialog)return;
    const dialog=document.createElement('dialog');dialog.className='schedule-editor-dialog';dialog.id='schedule-course-editor';dialog.setAttribute('aria-labelledby','schedule-course-editor-title');
    dialog.innerHTML=`<header><h2 id="schedule-course-editor-title">新增课程</h2><button type="button" data-editor-close>关闭</button></header>
    <form><div data-editor-mode role="group" aria-label="课程来源"><button class="btn-secondary" type="button" data-mode="existing" aria-pressed="false">选择已有课程</button><button class="btn-secondary" type="button" data-mode="custom" aria-pressed="true">自定义课程</button></div>
    <label data-editor-template hidden>已有课程<select name="template"></select></label>
    <div class="schedule-editor-basics"><label>课程名称<input name="name" required maxlength="120" autocomplete="off"></label><label>教室（选填）<input name="classroom" maxlength="200" autocomplete="off"></label></div>
    <input name="start_at" type="hidden"><input name="end_at" type="hidden">
    <div class="schedule-editor-time-fields"><div class="schedule-editor-date-line"><label>日期<input name="start_date" type="date" required></label><label class="schedule-editor-cross-day"><input name="cross_day" type="checkbox" data-editor-cross-day>跨日</label></div>
    <div class="schedule-editor-times"><label>开始时间<input name="start_clock" type="time" required step="60"></label><label>结束时间<input name="end_clock" type="time" required step="60"></label></div>
    <label data-editor-end-date hidden>结束日期<input name="end_date" type="date"></label></div>
    <div class="schedule-editor-extras"><button type="button" class="btn-secondary" data-editor-add-field>＋ 添加信息</button><div data-editor-fields></div></div>
    <p data-editor-error class="schedule-editor-error" role="alert"></p>
    <p class="schedule-editor-help" data-editor-source></p><p class="schedule-editor-help" data-editor-scope></p>
    <div class="schedule-editor-conflict" data-editor-conflict hidden><p></p><button type="button" class="btn-secondary" data-editor-save-conflict>仍然保存</button></div>
    <footer><button class="btn-primary" type="button" data-save="week">仅本周保存</button><button class="btn-secondary" type="button" data-save="all">全部周保存</button><button class="btn-secondary" type="button" data-editor-cancel>取消</button></footer>
    <div class="schedule-course-edit-actions"><button class="btn-secondary" type="button" data-editor-delete hidden>删除课程</button><button class="btn-secondary" type="button" data-editor-restore hidden>恢复教务时间</button></div></form>`;
    const scope=document.createElement('dialog');scope.className='schedule-editor-dialog schedule-scope-dialog';scope.id='schedule-scope-choice';scope.setAttribute('aria-labelledby','schedule-scope-title');
    scope.innerHTML='<header><h2 id="schedule-scope-title">选择生效范围</h2><button type="button" data-scope-cancel>关闭</button></header><p data-scope-description></p><p class="schedule-editor-conflict" data-scope-conflict hidden></p><footer><button class="btn-primary" type="button" data-scope="week">仅本周</button><button class="btn-secondary" type="button" data-scope="all">全部周</button><button class="btn-primary" type="button" data-scope-proceed hidden>仍然保存</button><button class="btn-secondary" type="button" data-scope-cancel>取消</button></footer>';
    document.body.append(dialog,scope);scheduleEditor.dialog=dialog;scheduleEditor.scopeDialog=scope;
    const form=dialog.querySelector('form');
    scheduleEditor.times=mountScheduleEditorTimes(form,resources);
    resources.listen(form,'input',()=>{clearScheduleConflict();rememberScheduleDraftForm();});
    resources.listen(form,'submit',event=>event.preventDefault());
    resources.listen(dialog.querySelector('[data-editor-close]'),'click',closeEditor);
    resources.listen(dialog.querySelector('[data-editor-cancel]'),'click',closeEditor);
    resources.listen(dialog,'close',()=>{rememberScheduleDraftForm();if(!scheduleEditor.pending)restoreEditorFocus();});
    for(const modal of [dialog,scope]){
        resources.listen(modal,'cancel',event=>{if(scheduleEditor.pending)event.preventDefault();else if(modal===dialog)rememberScheduleDraftForm();});
        resources.listen(modal,'click',event=>{if(event.target!==modal || scheduleEditor.pending)return;const r=modal.getBoundingClientRect();if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom){if(modal===dialog)rememberScheduleDraftForm();modal.close();}});
    }
    resources.listen(form.querySelector('[data-editor-add-field]'),'click',()=>{
        const fields=form.querySelector('[data-editor-fields]');if(fields.children.length>=30){showUiToast('最多添加30项信息','info');return;}
        const row=extraRow();fields.append(row);row.querySelector('input').focus();
        rememberScheduleDraftForm();
    });
    for(const button of form.querySelectorAll('[data-save]'))resources.listen(button,'click',()=>submitEditor(button.dataset.save));
    resources.listen(form.querySelector('[data-editor-save-conflict]'),'click',()=>{if(scheduleEditor.conflict)submitEditor(scheduleEditor.conflict,true);});
    for(const button of form.querySelectorAll('[data-mode]'))resources.listen(button,'click',()=>{
        form.querySelector('[data-editor-template]').hidden=button.dataset.mode!=='existing';
        form.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
        clearScheduleConflict();updateScheduleEditorSummary();rememberScheduleDraftForm();
    });
    resources.listen(form.elements.template,'change',()=>{
        const item=courseTemplateOptions(state.cachedSchedule).find(item=>item.event_id===form.elements.template.value);if(!item)return;
        const current={start_at:form.elements.start_at.value+':00+08:00',end_at:form.elements.end_at.value+':00+08:00'};
        const values=applyCourseTemplate(current,item);
        const old=[...form.querySelectorAll('.schedule-extra-row')].map(row=>({name:row.querySelector('input').value,value:row.querySelector('textarea').value}));
        const inherited=new Set(values.extra_fields.map(row=>JSON.stringify(row)));
        values.extra_fields=[...values.extra_fields,...old.filter(row=>!inherited.has(JSON.stringify(row)))];setEditorValues(values);
        clearScheduleConflict();rememberScheduleDraftForm();
    });
    for(const button of scope.querySelectorAll('[data-scope]'))resources.listen(button,'click',()=>{
        const action=scope._select;scope.close();if(action)action(button.dataset.scope);
    });
    for(const button of scope.querySelectorAll('[data-scope-cancel]'))resources.listen(button,'click',()=>scope.close());
    resources.listen(scope.querySelector('[data-scope-proceed]'),'click',()=>{const action=scope._proceed;scope._proceed=null;scope.close();action?.();});
    for(const action of ['delete','restore'])resources.listen(form.querySelector(`[data-editor-${action}]`),'click',()=>{
        const course=scheduleEditor.course;
        promptScheduleScope(action==='delete'?'删除课程的范围':'恢复教务时间的范围',scope=>{
            const write=()=>writeSchedule(`/api/schedule/${action==='delete'?'personal':'overrides'}/${encodeURIComponent(course.event_id)}`,'DELETE',{scope,week:state.currentWeek,revision:state.scheduleRevision});
            const preview={scope,action,start_at:course.original_start_at,end_at:course.original_end_at};
            if(action==='restore' && showScheduleConflicts(course,preview,false,write))return;
            return write();
        },'',course,action);
    });
    const describePlacement=(course,slot,resize=false)=>{
        const exactCourse=course || (scheduleEditor.draft?.values?.start_at && scheduleEditor.draft?.values?.end_at?{...scheduleEditor.draft.values,source:'custom'}:null);
        const times=exactCourse?resize?courseResizeTimes(exactCourse,state.currentWeek,slot,currentSemesterStartValue(),editorPeriods()):courseDropTimes(exactCourse,state.currentWeek,slot,currentSemesterStartValue(),editorPeriods()):
            periodSpanTimes(state.currentWeek,slot.day,slot.section,slot.duration,currentSemesterStartValue(),editorPeriods());
        return times?`周${'一二三四五六日'[slot.day-1]} · 第${slot.section}${slot.duration>1?'–'+(slot.section+slot.duration-1):''}节\n${courseClockLabel(times)}`:'此位置无法容纳完整课程';
    };
    scheduleEditor.cancelGestures=mountScheduleEditorGestures({isEnabled:canEditSchedule,getDraft:()=>scheduleEditor.draft,onDraft:createScheduleDraft,onDismiss:clearScheduleDraft,
        onResize:applyScheduleDraftPlacement,onMove:moveScheduleCourse,onCourseResize:resizeScheduleCourse,
        describeSlot:(course,slot)=>describePlacement(course,slot),describeSpan:(course,slot)=>describePlacement(course,slot,!!slot.edge),
        onCancel:draft=>{if(draft){scheduleEditor.draft=draft;renderScheduleDraft();}}});
    resources.addCleanup(unmountScheduleEditor);
}
export function unmountScheduleEditor() {
    resetScheduleEditor();cancelScheduleEditingGesture();clearScheduleDraft();
    document.getElementById('page-schedule')?.querySelector?.('.schedule-personal-notices')?.remove?.();
    scheduleEditor.dialog?.close();scheduleEditor.scopeDialog?.close();
    scheduleEditor.dialog?.remove();scheduleEditor.scopeDialog?.remove();
    Object.assign(scheduleEditor,{cancelGestures:null,dialog:null,scopeDialog:null,pending:false,course:null,returnFocus:null});
}
