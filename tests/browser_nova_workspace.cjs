// Real Jinja templates and production scripts; only HTTP boundaries use offline fixtures.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = process.env.NOVA_OUTPUT || '/tmp/urp-nova-preview';
const python = process.env.URP_PYTHON || path.join(root, '.venv/bin/python');
const render = (name, flags = []) => execFileSync(python, [path.join(__dirname, 'helpers/render-template.py'), name, ...flags], { encoding: 'utf8' });
const html = { '/': render('index.html'), '/admin': render('admin.html'), '/ad': render('ad_detail.html', ['--ad']), '/no-ad': render('ad_detail.html'), '/no-member': render('index.html', ['--no-member']), '/with-ad': render('index.html', ['--ad']) };
const start = '2026-09-28';
const course = { '课程名': '计算机网络与系统设计', '星期': 3, '节次': 1, '节数': 2, '位置': '第一教学楼 A201' };
const schedule = Object.fromEntries(Array.from({length: 25}, (_, i) => [i + 1, [course, { ...course, '课程名': '高等数学', '星期': 2, '节次': 3, '位置': '主楼 B310' }]]));
const event = { current: {title:'计算机网络与系统设计',location:'第一教学楼 A201',time:'08:20-10:00',remaining:35}, next: {title:'大学英语', location:'第二教学楼 B305', time:'2026-10-21 10:20', time_range:'10:20-12:00', type:'class', countdown:55}, upcoming_label:'今日安排', upcoming:[{title:'计算机网络与系统设计',location:'第一教学楼 A201',time:'08:20-10:00',status:'current'},{title:'大学英语',location:'第二教学楼 B305',time:'10:20-12:00',status:'upcoming'},{title:'数据库原理与应用',location:'实验楼 402',time:'14:00-15:40',status:'upcoming'}] };
const fixtures = {
 '/api/check_bind': {success:true,bound:true,username:'nova-offline',logged_in:true},
 '/api/check_login_status': {success:true,logged_in:true},
 '/api/check_login': {success:true,logged_in:true},
 '/api/urgent_event': {success:true,event},
 '/api/schedule': {success:true,data:{schedule,semester_start:start,exams:[],revision:0}},
 '/api/grades/latest_summary': {success:true,semester:'2026-2027-1',passed:[{course:'计算机网络与系统设计',credit:3,score:92},{course:'大学英语',credit:2,score:86}],failed:{current:[],past:[]}},
 '/api/grades/gpa': {success:true,gpa:{'学分绩点':3.65,'学期绩点明细':[{'学年学期':'2026-2027-1','学分绩点':3.65}]}},
 '/api/grades/failed': {success:true,current:[],past:[]},
 '/api/grades/latest_makeup': {success:true,latest_session:null,latest_published:null},
 '/api/feedback': {success:true,my_feedbacks:[],public_feedbacks:[]},
 '/api/member/status': {success:true,data:{is_member:true,member_type:'basic',expire_time:'2027-01-30'}},
 '/api/member/orders': {success:true,data:[]},
 '/api/member/api-key': {success:true,data:{has_key:false}},
 '/api/invitation/my_inviter': {success:true,data:{inviter:null}},
 '/api/invitation/earnings': {success:true,data:{earned:0,withdrawn:0,available:0,effective_invite_count:0}},
 '/api/invitation/withdrawals': {success:true,data:[]},
 '/api/lab/status': {success:true,student_id:'nova-offline',password_bound:false},
 '/api/exams': {success:true,exams:[{course:'计算机网络',exam_name:'期末考试',week:'4',day:'3',time:'08:20-10:00',location:'教学楼 A201'}]},
 '/api/announcements': {success:true,announcements:[{id:1,title:'使用说明',content:'课程、成绩和考试信息请以教务系统为准。\n'.repeat(30),create_time:'2026-10-20T12:00:00',is_read:true}]},
 '/api/admin/activity/today': {success:true,data:{date:'2026-10-25',active_users:0}},
 '/api/admin/users': {success:true,total:38,classes:[{class_id:'26150801',count:20},{class_id:'其他',count:18}],daily:[{date:'2026-10-21',count:3}]},
 '/api/admin/members': {success:true,data:[],members:[]},
 '/api/admin/withdrawals': {success:true,data:[]},
 '/api/admin/commission_stats': {success:true,data:{users:[],summary:{}}},
 '/api/admin/config': {success:false,message:'离线预览：未连接生产配置'},
};
(async () => {
 fs.mkdirSync(output,{recursive:true});
 const browser = await chromium.launch({channel:'chrome',headless:true});
 let assertions = 0;
 try {
  const context = await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await context.addInitScript(()=>{localStorage.setItem('current_page','home');localStorage.setItem('urp_miniapp_notice_dismissed','1');});
  const calls=[], errors=[];
  let guest = false, failGrades = false;
  await context.route('**/*',route=>{
   const p=new URL(route.request().url()).pathname;
   if(html[p])return route.fulfill({contentType:'text/html',body:html[p]});
   if(p==='/maintenance')return route.fulfill({contentType:'text/html',body:fs.readFileSync(root+'/maintenance.html','utf8')});
   if(p.startsWith('/static/') || p.startsWith('/maintenance-scenes/')) return route.fulfill({path:root+p});
   if(p==='/favicon.ico')return route.fulfill({status:204});
   calls.push({p,method:route.request().method()});
   if(guest && p==='/api/check_bind')return route.fulfill({json:{success:true,bound:false}});
   if(failGrades && p==='/api/grades/latest_summary')return route.fulfill({json:{success:false,message:'离线测试：暂时无法读取成绩'}});
   return route.fulfill({json:fixtures[p] || {success:true,bound:true,logged_in:true,username:'nova-offline',semester_start:start,data:{},announcements:[],exams:[]}});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const fit=async(label)=>{
   await page.waitForTimeout(100);
   const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
   assert.ok(geometry.scroll<=geometry.width+1,`${label}: page overflows ${JSON.stringify(geometry)}`);
   assertions++;
  };
  const shot=async(name)=>page.screenshot({path:path.join(output,name+'.png'),fullPage:true,animations:'disabled'});
  await page.goto('http://urp.test/');
  await page.waitForFunction(()=>window.URP?.store.getState().currentUsername==='nova-offline');
  for(const [width,height] of [[320,700],[390,844],[768,1024],[1100,800],[1440,1000]]) {
   await page.setViewportSize({width,height});
   for(const scheme of ['light','dark']) {
    await page.evaluate(scheme=>{localStorage.setItem('urp_ui_color_mode',scheme);document.documentElement.dataset.colorScheme=scheme;},scheme);
    for(const name of ['home','schedule','grades','evaluation','lab','service-status','feedback','shortcut-api','member','more']) {
     await page.evaluate(name=>{document.body.dataset.focusInput='pointer';openHomeShortcut(name);},name);
     await fit(`${width}/${scheme}/${name}`);
     assert.equal(await page.locator(`#page-${name}`).isVisible(),true);assertions++;
     if(width===1440 || (width===390 && ['home','grades','member','more'].includes(name)))await shot(`${width}-${scheme}-${name}`);
    }
   }
  }
  // CSSOM: all external styles belong to declared layers, themes only define tokens.
  const layerViolations=await page.evaluate(()=>{
   const violations=[];
   const tokensOnly=rules=>{for(const r of rules){if(r.cssRules)tokensOnly(r.cssRules);else if(r.style)for(const prop of r.style)if(!prop.startsWith('--')||r.style.getPropertyPriority(prop))violations.push(r.selectorText+':'+prop);}};
   for(const sheet of document.styleSheets){if(!sheet.href)continue;for(const rule of sheet.cssRules)if(!rule.constructor.name.startsWith('CSSLayer'))violations.push(sheet.href);if(/taste-theme\.css/.test(sheet.href))tokensOnly(sheet.cssRules);}return violations;
  });assert.deepEqual(layerViolations,[]);assertions++;
  // Normal motion: course shared-element morph must not replay the generic dialog entrance.
  await page.setViewportSize({width:1440,height:1000});
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>openHomeShortcut('schedule'));
  await page.locator('.is-current .course-card').first().click();
  await page.waitForFunction(()=>document.getElementById('course-detail-modal').classList.contains('is-course-morphing'));
  await page.waitForFunction(()=>!document.getElementById('course-detail-modal').classList.contains('is-course-morphing'));
  const settled=await page.locator('#course-detail-modal .modal-content').evaluate(el=>({opacity:getComputedStyle(el).opacity,animation:getComputedStyle(el).animationName}));
  assert.equal(settled.opacity,'1');assert.equal(settled.animation,'none');assertions+=2;
  await page.keyboard.press('Escape');await page.waitForTimeout(300);
  // Native navigation, menu dismiss and modal focus through actual controls.
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>openHomeShortcut('grades'));
  await page.locator('#grades-query-summary').click();assert.equal(await page.locator('#grades-query-options').getAttribute('open'),'');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#grades-query-options').getAttribute('open'),null);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'grades-query-summary');assertions+=3;
  await page.evaluate(()=>openHomeShortcut('home'));
  await page.locator('#announcement-trigger').click();await page.locator('#announcement-dialog-article').waitFor({state:'visible'});
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'announcement-trigger');assertions++;
  // Optional themes and manual mode remain independent; switching makes no API call.
  await page.locator('.appearance-trigger-header').click();
  await page.waitForTimeout(100);const before=calls.length;
  for(const theme of ['workspace','glass','paper','garden','clay']) {
   await page.locator(`.appearance-option:has(input[value=${theme}])`).click();
   assert.equal(await page.locator('html').getAttribute('data-ui-template'),theme);
   await page.locator('.appearance-color-mode:has(input[value=dark])').click();
   assert.equal(await page.locator('html').getAttribute('data-color-scheme'),'dark');
   await page.locator('.appearance-color-mode:has(input[value=light])').click();assertions+=2;
  }
  assert.equal(calls.length,before,'appearance does not query academic data');assertions++;
  await page.locator('.appearance-option:has(input[value=workspace])').click();await page.keyboard.press('Escape');
  // Explicit failure state stays readable, then the original retry/query recovers.
  failGrades=true;await page.evaluate(()=>{URP.store.setState({cachedGrades:null});openHomeShortcut('grades');});
  await page.waitForTimeout(150);await fit('grades/error');await shot('grades-error');failGrades=false;
  await page.locator('#grades-one-click').click();await page.waitForTimeout(120);
  // Payment dialog and confirmation shell: no order is submitted by this test.
  await page.evaluate(()=>openHomeShortcut('member'));await page.waitForTimeout(100);
  await page.locator('button[onclick="showPayDialog(\'basic\')"]').click();
  await page.locator('#pay-modal').waitFor({state:'visible'});await shot('payment-dialog');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#pay-modal').isVisible(),false);assertions++;
  // User login: retain required fields, native validation, guest escape and disclaimer.
  guest=true;await page.goto('http://urp.test/');await page.locator('#login-modal').waitFor({state:'visible'});
  for(const [width,height] of [[1440,900],[390,844],[320,568]]) {
   await page.setViewportSize({width,height});await fit('login/'+width);await shot('login-'+width);
   const box=await page.locator('#login-modal .login-card').boundingBox();assert.ok(box.width<=width && box.height<=height);assertions++;
  }
  await page.locator('#username').fill('offline-student');await page.locator('#password').fill('offline-password');
  await page.locator('#password-disclaimer-trigger').click();await page.locator('#password-disclaimer-modal').waitFor({state:'visible'});
  await page.keyboard.press('Escape');assert.equal(await page.locator('#login-modal').isVisible(),true);assertions++;
  await page.locator('.login-close').click();assert.equal(await page.locator('#login-modal').isVisible(),false);assertions++;
  guest=false;
  // All 10 actual admin tabs, desktop/mobile and both palettes.
  await page.goto('http://urp.test/admin');await page.locator('#admin-key').fill('offline-key');await page.locator('.login-btn').click();
  await page.locator('#admin-panel').waitFor({state:'visible'});
  for(const width of [320,390,768,1440]) {
   await page.setViewportSize({width,height:1000});
   for(const scheme of ['light','dark']) {
    await page.evaluate(s=>document.documentElement.dataset.colorScheme=s,scheme);
    for(const tab of ['users','monitor','members','announcements','ad-stats','feedback','withdrawals','config','wechat','service-status']) {
     await page.locator(`#tab-${tab}-button`).click();await fit(`admin/${width}/${scheme}/${tab}`);
     assert.equal(await page.locator(`#tab-${tab}-button`).getAttribute('aria-selected'),'true');assertions++;
     assert.doesNotMatch(await page.locator(`#tab-${tab}`).innerText(), /Cannot read properties|TypeError|ReferenceError/);
     if(width===1440 || (width===390 && ['users','members','config'].includes(tab)))await shot(`admin-${width}-${scheme}-${tab}`);
    }
   }
  }
  for(const address of ['/ad','/no-ad','/maintenance','/no-member','/with-ad']) {
   await page.goto('http://urp.test'+address);
   for(const width of [320,390,768,1440]) {await page.setViewportSize({width,height:900});await fit(address+'/'+width);}
   if(address==='/no-member')assert.equal(await page.locator('[data-page=member],#page-member').count(),0);
   await shot(address.slice(1));
  }
  assert.deepEqual(errors,[]);assertions++;
  assert.equal(calls.some(c=>c.method==='POST' && /create_order|withdraw/.test(c.p)),false);assertions++;
  console.log(`PASS: ${assertions} browser assertions; all user screens, 10 admin tabs, 5 widths, light/dark, 5 themes, modal focus, login, payment dialog, campaign and maintenance. No live requests.`);
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
