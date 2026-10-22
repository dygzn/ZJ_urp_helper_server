const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function setup() {
  const source = fs.readFileSync('static/js/admin.js', 'utf8');
  const timers = new Map(), events = {}; let next = 0, calls = 0, release;
  const document = {visibilityState:'visible', addEventListener:(n,f)=>events[n]=f,
    getElementById:()=>({textContent:'',innerHTML:''})};
  const ctx = vm.createContext({document, AbortController, console, adminKey:'test',
    setTimeout:(f,ms)=>{timers.set(++next,{f,ms});return next}, clearTimeout:id=>timers.delete(id),
    setInterval:(f,ms)=>{timers.set(++next,{f,ms});return next},clearInterval:id=>timers.delete(id),
    fetch:()=>{calls++;return new Promise(r=>release=()=>r({ok:true,json:async()=>({success:true,data:{online_count:0,users:[]}})}))},escapeHtml:s=>s});
  vm.runInContext(source.slice(source.indexOf('let monitorTimer ='),source.indexOf('// ==================== 会员管理')),ctx);
  return {ctx,document,timers,events,get calls(){return calls},release:()=>release()};
}
test('monitor coalesces requests, pauses while hidden, and resumes',async()=>{
  const s=setup(); const first=s.ctx.loadMonitorData(); const second=s.ctx.loadMonitorData();
  assert.equal(s.calls,1); s.release();await Promise.all([first,second]);
  s.ctx.startMonitorRefresh(); s.document.visibilityState='hidden';s.events.visibilitychange();
  assert.equal(s.timers.size,0);
  s.document.visibilityState='visible';s.events.visibilitychange();assert.equal(s.calls,2);
  s.release();await new Promise(r=>setImmediate(r));s.ctx.stopMonitorRefresh();assert.equal(s.timers.size,0);
});

test('monitor failures back off and stopping cancels the scheduled retry', async () => {
  const s = setup();
  s.ctx.console = {error(){}};
  s.ctx.fetch = async () => { throw new Error('offline'); };
  s.ctx.startMonitorRefresh();
  await s.ctx.loadMonitorData();
  assert.deepEqual([...s.timers.values()].map(timer=>timer.ms), [60000]);
  await s.ctx.loadMonitorData();
  assert.deepEqual([...s.timers.values()].map(timer=>timer.ms), [120000]);
  s.ctx.stopMonitorRefresh();
  assert.equal(s.timers.size,0);
});
