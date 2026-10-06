const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '..');
(async () => {
 const browser = await chromium.launch({channel:'chrome',headless:true});
 const page = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 const errors=[]; page.on('pageerror', e=>errors.push(e.message));
 let html=fs.readFileSync(root+'/templates/index.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/{%[\s\S]*?%}/g,'').replace(/{{[\s\S]*?}}/g,'');
 await page.route('**/*', async route=> {
   const url=new URL(route.request().url());
   if(url.pathname==='/') return route.fulfill({contentType:'text/html',body:html});
   if(url.pathname.startsWith('/static/')) {
     const file=root+url.pathname;
     if(fs.existsSync(file)) return route.fulfill({path:file});
   }
   return route.abort();
 });
 await page.goto('http://urp.test/');
 await page.evaluate(()=>{
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-schedule').classList.add('active');
  document.getElementById('page-title').textContent='日程表';
  document.querySelectorAll('.nav-item').forEach(el=>{el.classList.toggle('active',el.dataset.page==='schedule');if(el.dataset.page==='schedule')el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  document.getElementById('sidebar-username').textContent='演示账号';
  document.getElementById('login-status-indicator').textContent='已登录';
  document.querySelectorAll('.modal,.overlay').forEach(p=>p.style.display='none');
  document.getElementById('week-select').innerHTML='<option value="1">第 1 周</option>';
 });
 for(const file of ['schedule-layout.js','calendar-export.js','main.js']) await page.addScriptTag({content:fs.readFileSync(root+'/static/js/'+file,'utf8')});
 await page.evaluate(()=>{semesterStart=new Date('2026-09-28T00:00:00');});
 await page.evaluate(()=>displaySchedule({'1':[
  {'星期':1,'节次':1,'节数':2,'课程名':'高等数学','位置':'教学楼 A201'},
  {'星期':2,'节次':3,'节数':2,'课程名':'大学英语','位置':'教学楼 B305'},
  {'星期':3,'节次':5,'节数':2,'课程名':'程序设计基础','位置':'实验楼 302'},
  {'星期':4,'节次':7,'节数':2,'课程名':'大学物理','位置':'教学楼 C102'}
 ]}));


 for (const [width,height] of [[390,844],[375,667],[320,568],[1100,800],[1366,768],[1440,900],[1920,1080]]) {
  await page.setViewportSize({width,height});
  for(const open of [false,true]) {
   await page.evaluate(open=>open?showScheduleActions():hideScheduleActions(false),open);
   await page.waitForTimeout(300);
   const result=await page.evaluate(()=>{
    const rect=s=>document.querySelector(s).getBoundingClientRect();
    return {scrollHeight:document.documentElement.scrollHeight,viewport:innerHeight,
     grid:rect('.schedule-week-panel.is-current .schedule-grid').height,
     last:rect('.schedule-week-panel.is-current .timeline-item:nth-child(8)').bottom,
     toolbar:rect('.schedule-week-toolbar').top,actions:rect('#schedule-actions').bottom,
     content:rect('#schedule-content').height};
   });
   console.log(width,height,open,result);
   assert.ok(result.scrollHeight<=height+1);
   if (width < 1100) assert.ok(result.last<=result.toolbar+1);
   else {
    assert.ok(result.toolbar < result.last);
    assert.equal(await page.locator('#schedule-actions').getAttribute('inert'), null);
    assert.equal(await page.locator('#schedule-actions').getAttribute('aria-hidden'), 'false');
    assert.ok(await page.locator('#update-schedule-btn').isVisible());
    assert.equal(await page.locator('#menu-trigger').isVisible(), false);
    assert.equal(await page.locator('#sidebar').isVisible(), false);
    assert.ok(await page.locator('#desktop-navigation .nav-item').first().isVisible());
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   }
   assert.ok(result.grid>100);
   if(open) assert.ok(result.actions<=height);
   await page.screenshot({path:`/tmp/urp-fixed-${width}-${open}.png`});
  }
 }
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>hideScheduleActions(false));
 const cdp=await page.context().newCDPSession(page);
 const send=async(type,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x:180,y}]});
 await send('touchStart',600);
 for(const y of [560,520,480,440,400]) await send('touchMove',y);
 assert.equal(await page.locator('#schedule-actions').evaluate(el=>el.classList.contains('is-open')),false);
 assert.ok(await page.locator('.schedule-actions-pull-fill').evaluate(el=>parseFloat(el.style.width)<100));
 await send('touchEnd');
 assert.equal(await page.locator('#schedule-actions').evaluate(el=>el.classList.contains('is-open')),false);
 await send('touchStart',600);
 for(const y of [560,520,480,440,400,370]) await send('touchMove',y);
 assert.equal(await page.locator('.schedule-actions-pull-fill').evaluate(el=>el.style.width),'100%');
 assert.equal(await page.locator('#schedule-actions').evaluate(el=>el.classList.contains('is-open')),false);
 await send('touchEnd');
 assert.equal(await page.locator('#schedule-actions').evaluate(el=>el.classList.contains('is-open')),true);
 await send('touchStart',400); await send('touchMove',435); await send('touchEnd');
 assert.equal(await page.locator('#schedule-actions').evaluate(el=>el.classList.contains('is-open')),false);
 assert.equal(await page.evaluate(()=>scrollY),0);
 // An evening week must fit ten rows without moving the controls off screen.
 await page.evaluate(()=>document.querySelector('.schedule-week-panel.is-current .schedule-grid').classList.add('has-evening'));
 await page.evaluate(()=>showScheduleActions());
 assert.ok(await page.locator('.schedule-week-panel.is-current .timeline-item:last-child').evaluate(el=>el.getBoundingClientRect().bottom<=document.querySelector('.schedule-week-toolbar').getBoundingClientRect().top));
 await page.setViewportSize({width:1366,height:768});
 await page.evaluate(()=>{
  otherMajorScheduleData={'1':[{'星期':1,'节次':1,'节数':2,'课程名':'用于验证桌面点击的课程','位置':'教学楼 A201'}],'2':[]};
  currentWeek=1;
  displaySchedule(otherMajorScheduleData);
  updateScheduleDates(1);
 });
 await page.locator('.schedule-week-controls > button').nth(1).click();
 await page.waitForFunction(()=>currentWeek===2);
 await page.waitForTimeout(450);
 await page.locator('.schedule-week-controls > button').first().click();
 await page.waitForFunction(()=>currentWeek===1);
 await page.waitForTimeout(450);
 await page.evaluate(()=>document.getElementById('course-detail-modal').style.removeProperty('display'));
 await page.locator('.schedule-week-panel.is-current .course-card').first().click();
 await page.locator('#course-detail-modal.active').waitFor();
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#course-detail-modal').isVisible(),false);
 await page.locator('#schedule-more summary').click();
 assert.equal(await page.locator('#schedule-more .desktop-menu-items button').count(),3);
 assert.ok(await page.locator('#schedule-exams-btn').isVisible());
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#schedule-exams-btn').isVisible(),false);
 assert.equal(await page.evaluate(()=>document.activeElement.closest('details')?.id),'schedule-more');
 await page.locator('#desktop-nav-more summary').click();
 assert.equal(await page.locator('#desktop-nav-more .nav-item').count(),4);
 await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});
 await page.waitForTimeout(100);
 assert.equal(await page.locator('#sidebar .nav-item').count(),9);
 assert.equal(await page.locator('.schedule-data-actions > button').count(),4);
 await page.setViewportSize({width:1366,height:768});
 await page.waitForTimeout(100);
 assert.equal(await page.locator('#desktop-navigation .nav-item').count(),5);
 await page.evaluate(()=>setPageAccessLock('schedule',true));
 assert.equal(await page.locator('#page-schedule .schedule-container').isVisible(),false);
 assert.ok(await page.locator('#page-schedule [data-page-access-gate] button').isVisible());
 console.log('PASS: touch gestures; no scroll; evening rows; desktop week buttons, detail modal, guest gate');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
