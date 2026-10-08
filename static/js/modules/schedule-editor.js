import { pageResources } from './lifecycle.js';
import { state } from './store.js';
import { displaySchedule, PERIOD_TIMES_DEFAULT, PERIOD_TIMES_FRESHMAN } from './schedule.js';
import { currentSemesterStartValue } from './calendar.js';
import { closeUiModal, showUiToast } from './ui.js';
import { mountScheduleEditorGestures, cancelScheduleEditingGesture } from './schedule-editor-gestures.js';
import { courseTemplateOptions, applyCourseTemplate, periodSpanTimes, chinaDateTime, courseClockLabel, courseDropTimes } from './schedule-editor-model.js';
const resources = pageResources('schedule');
export const scheduleEditor = {epoch:0,cancelGestures:null,draft:null,dialog:null,scopeDialog:null,pending:false,course:null,returnFocus:null};
export function canEditSchedule() { return !scheduleEditor.pending && !state.isGuestMode && !state.otherMajorScheduleData && !!currentSemesterStartValue(); }
export function resetScheduleEditor() {
    scheduleEditor.epoch++;
    scheduleEditor.cancelGestures?.();
    clearScheduleDraft();
    scheduleEditor.pending=false;scheduleEditor.course=null;scheduleEditor.returnFocus=null;
    scheduleEditor.dialog?.close();scheduleEditor.scopeDialog?.close();
    const form=scheduleEditor.dialog?.querySelector?.('form');
    form?.reset();
    form?.querySelector?.('[data-editor-fields]')?.replaceChildren();
    form?.querySelector?.('[name="template"]')?.replaceChildren();
    if(scheduleEditor.scopeDialog){
        scheduleEditor.scopeDialog._select=null;
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
    button.setAttribute('aria-label',`新增课程，第${draft.section}至${draft.section+draft.duration-1}节，点击编辑，长按调整长度`);
    button.style.gridRow=`${draft.section} / span ${draft.duration}`;
    button.innerHTML='<span aria-hidden="true">＋</span><span>新增课程</span>';
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
function closeEditor() {scheduleEditor.dialog?.close();restoreEditorFocus();}
function extraRow(field={name:'',value:''}) {
    const row=document.createElement('div');row.className='schedule-extra-row';
    row.innerHTML='<label>数据名<input name="extra-name" maxlength="60"></label><label>数据内容<textarea name="extra-value" maxlength="2000" rows="2"></textarea></label><button type="button" class="btn-secondary" aria-label="删除这项信息">删除信息</button>';
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
    const fields=form.querySelector('[data-editor-fields]');fields.replaceChildren();
    for(const row of values.extra_fields || [])fields.append(extraRow(row));
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
    setEditorValues(course?{name:course['课程名'],classroom:course['位置'] || course['教室'],start_at:course.start_at,end_at:course.end_at,extra_fields:course.extra_fields || []}:{...clocks,name:'',classroom:'',extra_fields:[]});
    form.querySelector('[data-editor-template]').hidden=true;
    form.querySelectorAll('[data-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mode==='custom')));
    dialog.querySelector('h2').textContent=course?course.source==='custom'?'编辑课程':'修改课程时间':'新增课程';
    form.querySelector('[data-editor-delete]').hidden=!course || course.source!=='custom';
    form.querySelector('[data-editor-restore]').hidden=!course || course.source!=='urp' || !course.version;
    if(course?.source==='urp'){form.elements.name.disabled=true;form.elements.classroom.disabled=true;form.querySelector('[data-editor-add-field]').disabled=true;}
    if (!dialog.open)dialog.showModal();(course?.source==='urp'?form.elements.start_at:form.elements.name).focus();
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
async function submitEditor(scope) {
    const payload=inputPayload(scope);if(!payload)return;
    const course=scheduleEditor.course;
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
        state.cachedSchedule=result.data.schedule;state.scheduleRevision=result.data.revision;
        if(result.data.semester_key)state.scheduleSemesterKey=result.data.semester_key;
        state.personalScheduleNotices=result.data.notices || [];state.calendarExportData=null;
        if(method==='POST')clearScheduleDraft();displaySchedule(state.cachedSchedule);
        scheduleEditor.dialog?.close();scheduleEditor.scopeDialog?.close();restoreEditorFocus();
        showUiToast(result.message || '课程已保存','success');
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
export function promptScheduleScope(title,onSelect,description='') {
    if(scheduleEditor.pending)return;
    const dialog=scheduleEditor.scopeDialog;if(!dialog)return;
    dialog.querySelector('h2').textContent=title;
    dialog.querySelector('[data-scope-description]').textContent=description+'仅本周只修改这一次；全部周修改本学期同一上课时段的重复安排。取消不保存。';
    dialog._select=onSelect;if(!dialog.open)dialog.showModal();dialog.querySelector('[data-scope="week"]').focus();
}
export function moveScheduleCourse(course,slot) {
    const times=courseDropTimes(course,state.currentWeek,slot,currentSemesterStartValue(),editorPeriods());
    if(!times){showUiToast('此位置无法容纳完整课程，请在详情中修改精确时间','info');return;}
    promptScheduleScope(`调整 ${course['课程名']} 的时间`,scope=>{
        const path=`/api/schedule/${course.source==='custom'?'personal':'overrides'}/${encodeURIComponent(course.event_id)}`;
        return writeSchedule(path,course.source==='custom'?'PATCH':'PUT',{scope,revision:state.scheduleRevision,week:state.currentWeek,...times,
            name:course['课程名'],classroom:course['教室'] || '',time_mode:course.source==='urp' && course.time_mode==='period'?'period':'precise',extra_fields:course.extra_fields || []});
    },`新时间：${chinaDateTime(times.start_at).replace('T',' ')} 至 ${chinaDateTime(times.end_at).replace('T',' ')}。`);
}
export function appendScheduleEditActions(body,course,source) {
    if(!canEditSchedule() || !course.raw?.event_id || course.kind==='exam')return;
    const row=document.createElement('div');row.className='schedule-course-edit-actions';
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
        resources.listen(button,'click',()=>promptScheduleScope('清除时间调整的范围',scope=>writeSchedule(`/api/schedule/overrides/${encodeURIComponent(notice.event_id)}`,'DELETE',{scope,week:state.currentWeek,revision:state.scheduleRevision})));
        row.append(button);block.append(row);
    }
}
export function mountScheduleEditor() {
    if(scheduleEditor.dialog)return;
    const dialog=document.createElement('dialog');dialog.className='schedule-editor-dialog';dialog.id='schedule-course-editor';dialog.setAttribute('aria-labelledby','schedule-course-editor-title');
    dialog.innerHTML=`<header><h2 id="schedule-course-editor-title">新增课程</h2><button type="button" data-editor-close>关闭</button></header>
    <form><div data-editor-mode role="group" aria-label="课程来源"><button class="btn-secondary" type="button" data-mode="existing" aria-pressed="false">选择已有课程</button><button class="btn-secondary" type="button" data-mode="custom" aria-pressed="true">自定义课程</button></div>
    <label data-editor-template hidden>已有课程<select name="template"></select></label>
    <label>课程名称<input name="name" required maxlength="120" autocomplete="off"></label>
    <div class="schedule-editor-times"><label>开始时间<input name="start_at" type="datetime-local" required step="60"></label><label>结束时间<input name="end_at" type="datetime-local" required step="60"></label></div>
    <label>教室（选填）<input name="classroom" maxlength="200" autocomplete="off"></label>
    <div data-editor-fields></div><button type="button" class="btn-secondary" data-editor-add-field>＋ 添加信息</button>
    <p data-editor-error class="schedule-editor-error" role="alert"></p>
    <p class="schedule-editor-help">选择保存范围。时间重叠时会保留全部课程，请核对安排。</p>
    <footer><button class="btn-primary" type="button" data-save="week">仅本周保存</button><button class="btn-secondary" type="button" data-save="all">全部周保存</button><button class="btn-secondary" type="button" data-editor-cancel>取消</button></footer>
    <div class="schedule-course-edit-actions"><button class="btn-secondary" type="button" data-editor-delete hidden>删除课程</button><button class="btn-secondary" type="button" data-editor-restore hidden>恢复教务时间</button></div></form>`;
    const scope=document.createElement('dialog');scope.className='schedule-editor-dialog schedule-scope-dialog';scope.id='schedule-scope-choice';scope.setAttribute('aria-labelledby','schedule-scope-title');
    scope.innerHTML='<header><h2 id="schedule-scope-title">选择生效范围</h2><button type="button" data-scope-cancel>关闭</button></header><p data-scope-description></p><footer><button class="btn-primary" type="button" data-scope="week">仅本周</button><button class="btn-secondary" type="button" data-scope="all">全部周</button><button class="btn-secondary" type="button" data-scope-cancel>取消</button></footer>';
    document.body.append(dialog,scope);scheduleEditor.dialog=dialog;scheduleEditor.scopeDialog=scope;
    const form=dialog.querySelector('form');
    resources.listen(form,'submit',event=>event.preventDefault());
    resources.listen(dialog.querySelector('[data-editor-close]'),'click',closeEditor);
    resources.listen(dialog.querySelector('[data-editor-cancel]'),'click',closeEditor);
    resources.listen(dialog,'close',()=>{if(!scheduleEditor.pending)restoreEditorFocus();});
    for(const modal of [dialog,scope]){
        resources.listen(modal,'cancel',event=>{if(scheduleEditor.pending)event.preventDefault();});
        resources.listen(modal,'click',event=>{if(event.target!==modal || scheduleEditor.pending)return;const r=modal.getBoundingClientRect();if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom)modal.close();});
    }
    resources.listen(form.querySelector('[data-editor-add-field]'),'click',()=>{
        const fields=form.querySelector('[data-editor-fields]');if(fields.children.length>=30){showUiToast('最多添加30项信息','info');return;}
        const row=extraRow();fields.append(row);row.querySelector('input').focus();
    });
    for(const button of form.querySelectorAll('[data-save]'))resources.listen(button,'click',()=>submitEditor(button.dataset.save));
    for(const button of form.querySelectorAll('[data-mode]'))resources.listen(button,'click',()=>{
        form.querySelector('[data-editor-template]').hidden=button.dataset.mode!=='existing';
        form.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
    });
    resources.listen(form.elements.template,'change',()=>{
        const item=courseTemplateOptions(state.cachedSchedule).find(item=>item.event_id===form.elements.template.value);if(!item)return;
        const current={start_at:form.elements.start_at.value+':00+08:00',end_at:form.elements.end_at.value+':00+08:00'};
        const values=applyCourseTemplate(current,item);
        const old=[...form.querySelectorAll('.schedule-extra-row')].map(row=>({name:row.querySelector('input').value,value:row.querySelector('textarea').value}));
        values.extra_fields=[...values.extra_fields,...old];setEditorValues(values);
    });
    for(const button of scope.querySelectorAll('[data-scope]'))resources.listen(button,'click',()=>{
        const action=scope._select;scope.close();if(action)action(button.dataset.scope);
    });
    for(const button of scope.querySelectorAll('[data-scope-cancel]'))resources.listen(button,'click',()=>scope.close());
    for(const action of ['delete','restore'])resources.listen(form.querySelector(`[data-editor-${action}]`),'click',()=>{
        const course=scheduleEditor.course;
        promptScheduleScope(action==='delete'?'删除课程的范围':'恢复教务时间的范围',scope=>writeSchedule(`/api/schedule/${action==='delete'?'personal':'overrides'}/${encodeURIComponent(course.event_id)}`,'DELETE',
            {scope,week:state.currentWeek,revision:state.scheduleRevision}));
    });
    scheduleEditor.cancelGestures=mountScheduleEditorGestures({isEnabled:canEditSchedule,getDraft:()=>scheduleEditor.draft,onDraft:createScheduleDraft,
        onResize:draft=>{scheduleEditor.draft=draft;renderScheduleDraft();},onMove:moveScheduleCourse,
        describeSlot:(course,slot)=>{const span=courseDropTimes(course,state.currentWeek,slot,currentSemesterStartValue(),editorPeriods());return span?`星期${slot.day} 第${slot.section}节\n${courseClockLabel(span)}`:'此位置无法容纳完整课程';},
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
