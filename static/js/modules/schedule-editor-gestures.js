import { pageResources } from './lifecycle.js';
import { state } from './store.js';
import { resetScheduleSwipeGesture } from './schedule-gestures.js';
import { positionToSlot, resizeScheduleSpan } from './schedule-editor-model.js';
const resources = pageResources('schedule');
const DOUBLE_TAP_MS = 500;
const DOUBLE_TAP_DISTANCE = 40;
export const editorPointer = { id:null, timer:null, frame:null, active:false, x:0, y:0, moved:false, mode:null };
export function isScheduleEditingGesture() { return editorPointer.active; }
export function scheduleGridGeometry() {
    const panel=document.querySelector('.schedule-week-panel.is-current');
    if (!panel) return {columns:[],rows:8,gap:0};
    const columns=[...panel.querySelectorAll('.schedule-day-column')].filter(el=>el.getClientRects().length)
        .map(el=>{const rect=el.getBoundingClientRect();return {day:Number(el.dataset.scheduleColumnDay),left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};})
        .filter(col=>col.bottom>col.top);
    const column=panel.querySelector('.schedule-day-column');
    return {columns,rows:document.getElementById('page-schedule').classList.contains('has-draft-evening') || panel.querySelector('.schedule-grid').classList.contains('has-evening')?10:8,
        gap:typeof getComputedStyle==='function' && column?parseFloat(getComputedStyle(column).rowGap)||0:0};
}
export function cancelScheduleEditingGesture() {
    if (editorPointer.timer!==null) resources.clearTimeout(editorPointer.timer);
    if (editorPointer.frame!==null) resources.cancelAnimationFrame(editorPointer.frame);
    editorPointer.timer=null;editorPointer.frame=null;editorPointer.active=false;editorPointer.id=null;editorPointer.mode=null;
    document.getElementById('page-schedule')?.classList.remove('is-course-editing');
    document.getElementById('schedule-course-drag-preview')?.remove?.();
}
export function mountScheduleEditorGestures({onDraft,onResize,onMove,onCourseResize,onCancel,onDismiss,isEnabled,getDraft}) {
    const viewport=document.getElementById('schedule-content');
    if (!viewport) return ()=>{};
    let tap=null,candidate=null,originalDraft=null,lastSlot=null,preview=null,captureId=null,selection=null;
    let geometry=null,rect=null,initialSlot=null,originalStyle=null,rowStep=1,resizedDuration=1,pending=null,createdOnDown=false;
    let lastCreated=null,resizedSpan=null;
    const now=event=>Number.isFinite(event.timeStamp)?event.timeStamp:performance.now();
    // 触屏浏览器会把邻近空白点击吸附到小按钮；编辑按实际触点判断。
    const targetAt=event=>event.pointerType==='touch'?document.elementFromPoint?.(event.clientX,event.clientY) || event.target:event.target;
    const slotAt=(point,grid)=>{
        const slot=positionToSlot(point,grid);
        if(slot)return slot;
        // 网格的细分隔线也属于空白处，映射到最近的一列。
        const near=grid.columns.find(col=>point.y>=col.top && point.y<=col.bottom && point.x>=col.left-4 && point.x<=col.right+4);
        return near?positionToSlot({x:Math.max(near.left,Math.min(near.right,point.x)),y:point.y},grid):null;
    };
    const blankSlot=event=>{
        const target=targetAt(event);
        if(target.closest?.('.course-card, .schedule-course-draft, button, a, input, select, textarea'))return null;
        const panel=target.closest?.('.schedule-week-panel');
        if(!panel?.classList.contains('is-current') && target!==viewport)return null;
        return slotAt({x:event.clientX,y:event.clientY},scheduleGridGeometry());
    };
    const release=()=>{if(captureId!==null){try{viewport.releasePointerCapture(captureId);}catch{}captureId=null;}};
    const clearSelection=()=>{
        selection?.element.classList.remove('is-editor-selected');selection=null;
        if(!editorPointer.active)document.getElementById('schedule-course-drag-preview')?.remove?.();
    };
    const drawFrame=box=>{
        const frame=document.createElement('div');frame.id='schedule-course-drag-preview';frame.className='schedule-course-drag-preview';frame.setAttribute('aria-hidden','true');
        for(const [direction,edge] of [['up','start'],['down','end']]){
            const handle=document.createElement('span');handle.className='schedule-drag-arrow';handle.dataset.dragArrow=direction;handle.dataset.scheduleResizeEdge=edge;
            // 抓手随临时框一起移除，不留在页面级监听清理队列中。
            handle.addEventListener('pointerdown',down,{capture:true,passive:false});frame.append(handle);
        }
        frame.style.left=`${box.left}px`;frame.style.top=`${box.top}px`;frame.style.width=`${box.width}px`;frame.style.height=`${box.height}px`;document.body.append(frame);
        return frame;
    };
    const selectCard=element=>{
        if(element.isConnected===false || !isEnabled())return;
        selection={element,week:state.currentWeek};element.classList.add('is-editor-selected');drawFrame(element.getBoundingClientRect());
    };
    const restoreCard=()=>{
        if(candidate && originalStyle){Object.assign(candidate.element.style,originalStyle);candidate.element.classList.remove('is-editor-dragging');}
        originalStyle=null;
    };
    const clear=()=>{
        clearSelection();release();restoreCard();cancelScheduleEditingGesture();
        candidate=null;originalDraft=null;lastSlot=null;preview=null;geometry=null;rect=null;initialSlot=null;pending=null;createdOnDown=false;resizedSpan=null;
    };
    const cancel=()=>{
        const active=editorPointer.active,draft=originalDraft;
        clear();tap=null;
        if(active)onCancel(draft);
    };
    const consume=event=>{event.preventDefault();event.stopImmediatePropagation();state.suppressScheduleSwipeClick=true;};
    const create=(slot,event)=>{
        consume(event);resetScheduleSwipeGesture();tap=null;
        lastCreated={time:now(event),x:event.clientX,y:event.clientY,week:state.currentWeek};onDraft(slot);
    };
    const down=event=>{
        if(!isEnabled() || event.button>0)return;
        if(editorPointer.id!==null || event.isPrimary===false){cancel();return;}
        const point={x:event.clientX,y:event.clientY};
        const hit=targetAt(event),frameHandle=hit.closest?.('[data-schedule-resize-edge]');
        const fromHandle=!!frameHandle && !!hit.closest?.('#schedule-course-drag-preview') && !!selection;
        if(fromHandle && (selection.element.isConnected===false || selection.week!==state.currentWeek)){cancel();return;}
        const match=tap && tap.week===state.currentWeek && now(event)-tap.time<=DOUBLE_TAP_MS
            && Math.hypot(point.x-tap.x,point.y-tap.y)<=DOUBLE_TAP_DISTANCE;
        if(match && !state.scheduleSwipeTransition){
            const slot=blankSlot(event);
            if(slot){
                editorPointer.id=event.pointerId;createdOnDown=true;captureId=event.pointerId;
                viewport.setPointerCapture(captureId);create(tap.slot,event);return;
            }
        }
        if(state.scheduleSwipeTransition)return;
        const target=fromHandle?selection.element:hit,panel=target.closest?.('.schedule-week-panel');
        if(!panel?.classList.contains('is-current'))return;
        const draft=target.closest?.('.schedule-course-draft');
        const card=target.closest?.('.course-card');
        const course=card && state.currentScheduleMap.get(card.dataset.courseId);
        if(course?.kind==='exam' || (card && !course?.raw?.event_id))return;
        if(!draft && !card && !blankSlot(event))return;
        editorPointer.id=event.pointerId;editorPointer.x=event.clientX;editorPointer.y=event.clientY;editorPointer.moved=false;
        candidate=draft?{mode:'move',element:draft,draft:true}:course?{mode:'move',element:card,course:course.raw,placement:course}:null;
        originalDraft=getDraft()?{...getDraft()}:null;lastSlot=null;
        if(candidate){
            clearSelection();
            const sourceRect=candidate.element.getBoundingClientRect();
            const handle=fromHandle?frameHandle:target.closest?.('[data-schedule-resize-edge]');
            const edgeZone=candidate.draft?sourceRect.height/3:Math.min(14,sourceRect.height*.2);
            const edge=handle?.dataset.scheduleResizeEdge || (point.y-sourceRect.top<edgeZone?'start':sourceRect.bottom-point.y<edgeZone?'end':null);
            if(edge){candidate.mode='resize';candidate.edge=edge;}
            candidate.lastPoint=point;
            candidate.span=candidate.draft?originalDraft:{section:course.section,duration:course.duration};
            tap=null;
            const activate=()=>{
                editorPointer.timer=null;
                if(editorPointer.id===null || editorPointer.moved || candidate.element.isConnected===false)return;
                geometry=scheduleGridGeometry();rect=candidate.element.getBoundingClientRect();
                if(!geometry.columns.length)return;
                editorPointer.x=candidate.lastPoint.x;editorPointer.y=candidate.lastPoint.y;
                rowStep=(geometry.columns[0].bottom-geometry.columns[0].top+geometry.gap)/geometry.rows;
                initialSlot=slotAt({x:rect.left+rect.width/2,y:rect.top+rowStep/2},geometry);
                originalStyle={transform:candidate.element.style.transform,height:candidate.element.style.height,zIndex:candidate.element.style.zIndex};
                const base=typeof getComputedStyle==='function'?getComputedStyle(candidate.element).transform:'none';
                candidate.baseTransform=base && base!=='none'?base+' ':'';
                resizedSpan={...candidate.span};resizedDuration=resizedSpan.duration;
                editorPointer.active=true;editorPointer.mode=candidate.mode;
                resetScheduleSwipeGesture();state.suppressScheduleSwipeClick=true;captureId=editorPointer.id;viewport.setPointerCapture(captureId);
                // 只改变拖动状态，不展开列数或重排时间轴。
                document.getElementById('page-schedule').classList.add('is-course-editing');
                candidate.element.classList.add('is-editor-dragging');candidate.element.style.zIndex='20';
                preview=drawFrame(rect);preview.dataset.resizeEdge=candidate.edge || '';
            };
            if(fromHandle){consume(event);activate();}
            else editorPointer.timer=resources.setTimeout(activate,candidate.draft?300:450);
        }
    };
    const render=event=>{
        if(!editorPointer.active || !candidate || !geometry)return;
        const dx=event.clientX-editorPointer.x,dy=event.clientY-editorPointer.y;
        if(Math.hypot(dx,dy)>2)editorPointer.moved=true;
        if(candidate.mode==='resize'){
            const span=candidate.span,edge=candidate.edge;
            const offset=edge==='start'?Math.max((1-span.section)*rowStep,Math.min((span.duration-1)*rowStep,dy)):0;
            const height=edge==='start'?rect.height-offset:Math.max(rowStep-geometry.gap,Math.min((10-span.section+1)*rowStep-geometry.gap,rect.height+dy));
            const section=edge==='start'?span.section+Math.round(offset/rowStep):span.section+Math.round((height+geometry.gap)/rowStep)-1;
            resizedSpan=resizeScheduleSpan(span,edge,section);resizedDuration=resizedSpan.duration;
            candidate.element.style.height=`${Math.round(height)}px`;preview.style.height=`${Math.round(height)}px`;
            candidate.element.style.transform=`${candidate.baseTransform}translate3d(0, ${offset}px, 0)`;preview.style.transform=`translate3d(0, ${offset}px, 0)`;
        }else{
            candidate.element.style.transform=`${candidate.baseTransform}translate3d(${dx}px, ${dy}px, 0)`;
            preview.style.transform=`translate3d(${dx}px, ${dy}px, 0)`;
            // 以卡片首行中心定位，保留用户抓住卡片的位置。
            lastSlot=slotAt({x:rect.left+dx+rect.width/2,y:rect.top+dy+rowStep/2},geometry);
            preview.classList.toggle('is-invalid',!lastSlot);
        }
    };
    const move=event=>{
        if(event.pointerId!==editorPointer.id)return;
        if(createdOnDown){consume(event);return;}
        if(!editorPointer.active){
            const dx=Math.abs(event.clientX-editorPointer.x),dy=Math.abs(event.clientY-editorPointer.y);
            const moved=candidate?.draft && candidate.mode==='resize'?dx>10 || dy>18:Math.hypot(dx,dy)>8;
            if(moved){editorPointer.moved=true;tap=null;if(editorPointer.timer!==null)resources.clearTimeout(editorPointer.timer);editorPointer.timer=null;}
            else if(candidate)candidate.lastPoint={x:event.clientX,y:event.clientY};
            return;
        }
        consume(event);pending=event;
        if(editorPointer.frame!==null)return;
        editorPointer.frame=resources.requestAnimationFrame(()=>{editorPointer.frame=null;const latest=pending;pending=null;if(latest)render(latest);});
    };
    const up=event=>{
        if(event.pointerId!==editorPointer.id)return;
        if(createdOnDown){consume(event);clear();return;}
        if(editorPointer.active){
            consume(event);
            if(editorPointer.frame!==null){resources.cancelAnimationFrame(editorPointer.frame);editorPointer.frame=null;}
            render(event); // 即使浏览器合并了末次 move，松手位置也不能丢失。
            const mode=candidate.mode,course=candidate.course,draft=originalDraft,slot=lastSlot,span=resizedSpan,moved=editorPointer.moved,isDraft=candidate.draft,edge=candidate.edge,day=initialSlot?.day,element=candidate.element;
            const unchanged=mode==='move'?slot && initialSlot && slot.day===initialSlot.day && slot.section===initialSlot.section:span.duration===candidate.span.duration && span.section===candidate.span.section;
            clear();
            if(!moved || unchanged){onCancel(draft);selectCard(element);}
            else if(mode==='move' && !slot)onCancel(draft);
            else if(mode==='resize' && isDraft)onResize({...draft,...span,day},{mode,edge});
            else if(mode==='resize')onCourseResize?.(course,{...span,day,edge});
            else if(isDraft && slot.section+draft.duration-1<=10)onResize({...draft,...slot},{mode});
            else if(isDraft)onCancel(draft);
            else onMove(course,slot);
            return;
        }
        const moved=editorPointer.moved,hadCandidate=!!candidate;
        clear();
        if(!hadCandidate && !moved && isEnabled()){
            const slot=blankSlot(event);
            // 保留创建记录，拦住浏览器把邻近的取消点击合成另一场 dblclick。
            if(slot && getDraft()){consume(event);resetScheduleSwipeGesture();onDismiss?.();}
            tap=slot?{slot,time:now(event),x:event.clientX,y:event.clientY,week:state.currentWeek}:null;
        }else tap=null;
    };
    resources.listen(viewport,'pointerdown',down,true);
    resources.listen(viewport,'pointermove',move,{capture:true,passive:false});
    resources.listen(viewport,'pointerup',up,true);
    resources.listen(viewport,'pointercancel',cancel,true);
    resources.listen(viewport,'contextmenu',event=>{if(candidate || editorPointer.active)event.preventDefault();});
    resources.listen(document,'pointerdown',event=>{if(selection && !event.target.closest?.('#schedule-course-drag-preview'))clearSelection();},true);
    resources.listen(document,'click',event=>{if(selection && event.detail===0 && !event.target.closest?.('#schedule-course-drag-preview'))clearSelection();},true);
    resources.listen(document,'focusin',event=>{
        if(selection && event.target!==selection.element && !selection.element.contains?.(event.target)
            && !event.target.closest?.('#schedule-course-drag-preview'))clearSelection();
    });
    resources.listen(viewport,'dblclick',event=>{
        if(!isEnabled() || editorPointer.active || state.scheduleSwipeTransition)return;
        const slot=blankSlot(event);if(!slot)return;
        consume(event);
        if(lastCreated && lastCreated.week===state.currentWeek && now(event)-lastCreated.time<600 && Math.hypot(event.clientX-lastCreated.x,event.clientY-lastCreated.y)<=DOUBLE_TAP_DISTANCE)return;
        create(slot,event);
    });
    resources.listen(viewport,'touchstart',event=>{if(event.touches.length>1)cancel();},{passive:true,capture:true});
    resources.listen(viewport,'touchmove',event=>{if(editorPointer.active || createdOnDown){event.preventDefault();event.stopPropagation();}},{passive:false,capture:true});
    resources.listen(document,'keydown',event=>{if(event.key==='Escape' && (editorPointer.id!==null || selection)){event.preventDefault();cancel();}});
    resources.listen(window,'scroll',()=>{if(selection)clearSelection();},{capture:true,passive:true});
    if(typeof MutationObserver==='function'){
        const observer=resources.observe(new MutationObserver(()=>{if(selection?.element.isConnected===false)clearSelection();}));
        observer.observe(viewport,{childList:true,subtree:true});
    }
    resources.listen(window,'blur',cancel);resources.listen(window,'resize',cancel);resources.addCleanup(cancel);
    return cancel;
}
