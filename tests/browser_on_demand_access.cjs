const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'..');
const html=execFileSync(root+'/.venv/bin/python',[root+'/tests/helpers/render-template.py','index.html'],{encoding:'utf8'});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  for(const width of [1440,390]) {
   const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
   const calls=[],errors=[];
   await context.addInitScript(()=>{localStorage.setItem('urp_miniapp_notice_dismissed','1')});
   await context.route('**/*',r=>{
    const p=new URL(r.request().url()).pathname;
    if(p==='/')return r.fulfill({contentType:'text/html',body:html});
    if(p.startsWith('/static/'))return r.fulfill({path:root+p});
    calls.push(p);
    const data={
     '/api/check_bind':{success:true,bound:true,username:'student'},
     '/api/urgent_event':{success:true,event:{current:null,next:null,upcoming:[],upcoming_label:'今日安排'}},
     '/api/schedule':{success:true,data:{schedule:{'1':[]},semester_start:'2026-09-28',exams:[]}},
     '/api/announcements':{success:true,announcements:[]},
     '/api/update_schedule':{success:true,data:{}},
    }[p]||{success:true,data:{}};
    return r.fulfill({json:data});
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://urp-offline.test/');
   await page.waitForFunction(()=>document.querySelector('#page-home.active') && !document.querySelector('#urgent-content .home-events-loading'));
   assert(!calls.includes('/api/check_login_status'),'home must not check school cookie');
   assert.equal(await page.locator('#login-status-indicator').count(),0);
   await page.evaluate(()=>openHomeShortcut('schedule'));
   await page.waitForTimeout(300);
   assert(!calls.includes('/api/check_login_status'),'cached schedule must not check school cookie');
   assert.equal(await page.locator('button:visible').filter({hasText:/^更新课表$/}).count(),0);
   if(width>=1100)await page.locator('#schedule-more > summary').click();
   else await page.locator('#schedule-mobile-more').click();
   const update=page.locator('button:visible').filter({hasText:/^更新课表$/});
   await update.waitFor({state:'visible'});
   assert.equal(await update.count(),1);
   await update.click();
   await page.waitForTimeout(300);
   assert.equal(calls.filter(p=>p==='/api/update_schedule').length,1);
   assert.deepEqual(errors,[]);
   await page.screenshot({path:`/tmp/urp-on-demand-${width}.png`,fullPage:true});
   console.log(`PASS width=${width}: local reads without login probes; one menu update action`);
   await context.close();
  }
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
