import { pageResources } from './lifecycle.js';
import { state } from './store.js';
import { resetScheduleSwipeGesture } from './schedule-gestures.js';
import { positionToSlot, resizeDuration } from './schedule-editor-model.js';
const resources = pageResources('schedule');
export const editorPointer = { id:null, timer:null, active:false, x:0, y:0, moved:false, mode:null };
export function isScheduleEditingGesture() { return editorPointer.active; }
export function scheduleGridGeometry() {
    const panel=document.querySelector('.schedule-week-panel.is-current');
    if (!panel) return {columns:[],rows:8};
    return {rows:document.getElementById('page-schedule').classList.contains('is-course-editing') || document.getElementById('page-schedule').classList.contains('has-draft-evening') || panel.querySelector('.schedule-grid').classList.contains('has-evening')?10:8,
        columns:[...panel.querySelectorAll('.schedule-day-column')].filter(el=>el.getClientRects().length).map(el=>{
            const rect=el.getBoundingClientRect();return {day:Number(el.dataset.scheduleColumnDay),left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};
        })};
}
export function cancelScheduleEditingGesture() {
    if (editorPointer.timer!==null) resources.clearTimeout(editorPointer.timer);
    editorPointer.timer=null;editorPointer.active=false;editorPointer.id=null;editorPointer.mode=null;
    document.getElementById('page-schedule')?.classList.remove('is-course-editing');
    document.getElementById('schedule-course-drag-preview')?.remove?.();
}
export function mountScheduleEditorGestures({onDraft,onResize,onMove,onCancel,isEnabled,getDraft,describeSlot}) {
    const viewport=document.getElementById('schedule-content');
    if (!viewport) return ()=>{};
    let tap=null, candidate=null, originalDraft=null, lastSlot=null, preview=null, captureId=null;
    const cancel=()=>{
        if (editorPointer.active) onCancel(originalDraft);
        if (captureId!==null) {try {viewport.releasePointerCapture(captureId);} catch {} captureId=null;}
        cancelScheduleEditingGesture();candidate=null;originalDraft=null;lastSlot=null;preview=null;tap=null;
    };
    const down=event=>{
        if (!isEnabled() || state.scheduleSwipeTransition || event.button>0) return;
        if (editorPointer.id!==null) {cancel();return;}
        if (event.isPrimary===false) {cancel();return;}
        const panel=event.target.closest?.('.schedule-week-panel');
        if (!panel?.classList.contains('is-current')) return;
        const draft=event.target.closest?.('.schedule-course-draft');
        const card=event.target.closest?.('.course-card');
        const course=card && state.currentScheduleMap.get(card.dataset.courseId);
        if (course?.kind==='exam' || (card && !course?.raw?.event_id)) return;
        if (!draft && !card && !event.target.closest?.('.schedule-day-column')) return;
        editorPointer.id=event.pointerId;editorPointer.x=event.clientX;editorPointer.y=event.clientY;editorPointer.moved=false;
        candidate=draft?{mode:'resize',element:draft}:course?.raw?.event_id?{mode:'move',element:card,course:course.raw}:null;
        originalDraft=getDraft()?{...getDraft()}:null;lastSlot=null;
        if (candidate) editorPointer.timer=resources.setTimeout(()=>{
            editorPointer.timer=null;
            if (editorPointer.id===null || editorPointer.moved) return;
            editorPointer.active=true;editorPointer.mode=candidate.mode;tap=null;
            resetScheduleSwipeGesture();state.suppressScheduleSwipeClick=true;
            captureId=editorPointer.id;
            viewport.setPointerCapture(captureId);
            document.getElementById('page-schedule').classList.add('is-course-editing');
            if (candidate.mode==='move') {
                preview=document.createElement('div');preview.id='schedule-course-drag-preview';preview.className='schedule-course-drag-preview';
                preview.textContent=candidate.course['课程名'];document.body.append(preview);
                preview.style.left=`${editorPointer.x}px`;preview.style.top=`${editorPointer.y}px`;
            }
        },450);
    };
    const move=event=>{
        if (event.pointerId!==editorPointer.id) return;
        if (!editorPointer.active) {
            if (Math.hypot(event.clientX-editorPointer.x,event.clientY-editorPointer.y)>8) {
                editorPointer.moved=true;
                if (editorPointer.timer!==null) resources.clearTimeout(editorPointer.timer);
                editorPointer.timer=null;
            }
            return;
        }
        event.preventDefault();event.stopImmediatePropagation();
        lastSlot=positionToSlot({x:event.clientX,y:event.clientY},scheduleGridGeometry());
        if (candidate.mode==='resize' && originalDraft && lastSlot) {
            onResize({...originalDraft,duration:resizeDuration(originalDraft.section,lastSlot.section)});
        } else if (preview) {
            preview.style.left=`${event.clientX}px`;preview.style.top=`${event.clientY}px`;
            preview.classList.toggle('is-invalid',!lastSlot);
            preview.textContent=candidate.course['课程名']+'\n'+(lastSlot?describeSlot?.(candidate.course,lastSlot) || '':'拖回课表内放置');
        }
    };
    const up=event=>{
        if (event.pointerId!==editorPointer.id) return;
        const active=editorPointer.active,mode=editorPointer.mode,moved=editorPointer.moved;
        if (active) {
            event.preventDefault();event.stopImmediatePropagation();state.suppressScheduleSwipeClick=true;
            const course=candidate?.course;
            if (captureId!==null) {try {viewport.releasePointerCapture(captureId);} catch {} captureId=null;}
            cancelScheduleEditingGesture();
            if (!lastSlot) onCancel(originalDraft);
            else if (mode==='move') onMove(course,lastSlot);
        } else {
            if (editorPointer.timer!==null) resources.clearTimeout(editorPointer.timer);
            editorPointer.timer=null;editorPointer.id=null;
            if (!candidate && !moved && isEnabled()) {
                const slot=positionToSlot({x:event.clientX,y:event.clientY},scheduleGridGeometry());
                const now=performance.now();
                if (slot && tap && now-tap.time<=320 && Math.hypot(event.clientX-tap.x,event.clientY-tap.y)<=20
                    && slot.day===tap.slot.day && slot.section===tap.slot.section) {
                    // 新草稿出现在当前手指下方；阻止本次双击的合成 click 立即打开编辑器。
                    event.preventDefault();event.stopImmediatePropagation();
                    resetScheduleSwipeGesture();tap=null;state.suppressScheduleSwipeClick=true;onDraft(slot);
                } else tap=slot?{slot,time:now,x:event.clientX,y:event.clientY}:null;
            } else tap=null;
        }
        candidate=null;originalDraft=null;lastSlot=null;preview=null;
    };
    resources.listen(viewport,'pointerdown',down,true);
    resources.listen(viewport,'pointermove',move,{capture:true,passive:false});
    resources.listen(viewport,'pointerup',up,true);
    resources.listen(viewport,'pointercancel',cancel,true);
    resources.listen(viewport,'contextmenu',event=>{if(candidate || editorPointer.active)event.preventDefault();});
    resources.listen(viewport,'dblclick',event=>event.preventDefault());
    resources.listen(viewport,'touchstart',event=>{if(event.touches.length>1)cancel();},{passive:true,capture:true});
    // 编辑时阻止纵向旧手势与浏览器滚动；未进入长按前继续原行为。
    resources.listen(viewport,'touchmove',event=>{if(editorPointer.active){event.preventDefault();event.stopPropagation();}},{passive:false,capture:true});
    resources.listen(document,'keydown',event=>{if(event.key==='Escape' && editorPointer.id!==null){event.preventDefault();cancel();}});
    resources.listen(window,'blur',cancel);
    resources.listen(window,'resize',cancel);
    resources.addCleanup(cancel);
    return cancel;
}
