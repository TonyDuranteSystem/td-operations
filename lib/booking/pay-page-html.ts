/**
 * Booking page, PAID links — the words and the markup of OUR public page /pay/b/<code> (dev job 74432428). PURE: no database, no network, no clock.
 *
 * Two views of the same address:
 *   BOOK   nobody has booked with this link yet: the person picks one of the free times, types their name and email and presses "Book and pay"
 *   PAY    a time is booked and nothing is paid: the amount, the call's time and "Pay by card"
 * The page is plain HTML with a small script (no framework: it is a public page with no login, kept small and self-contained). Everything that comes from the database is
 * escaped before it reaches the markup; the link's code is a strict 22-character id and is the only thing put in the script, as JSON.
 */

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")

export const htmlHead = (title: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>` +
  `<style>body{font-family:Arial,Helvetica,sans-serif;max-width:32rem;margin:2.5rem auto;padding:0 1rem;color:#1e293b}h1{font-size:1.3rem}h2{font-size:1rem;margin:1.4rem 0 .5rem}` +
  `.box{border:1px solid #e2e8f0;border-radius:.6rem;padding:1.1rem 1.2rem;margin:1.2rem 0}.amt{font-size:1.8rem;font-weight:700;margin:.2rem 0}.muted{color:#64748b;font-size:.9rem}` +
  `button{background:#0f172a;color:#fff;border:0;border-radius:.5rem;padding:.75rem 1.3rem;font-size:1rem;cursor:pointer;width:100%}button:disabled{background:#94a3b8;cursor:not-allowed}` +
  `.chips{display:flex;flex-wrap:wrap;gap:.4rem;margin:.4rem 0}.chips button{width:auto;background:#fff;color:#0f172a;border:1px solid #cbd5e1;padding:.45rem .8rem;font-size:.9rem}` +
  `.chips button.on{background:#0f172a;color:#fff;border-color:#0f172a}input{box-sizing:border-box;width:100%;padding:.65rem .75rem;margin:.25rem 0 .6rem;border:1px solid #cbd5e1;border-radius:.5rem;font-size:1rem}` +
  `.err{color:#b91c1c;min-height:1.2rem;margin:.6rem 0 0}</style></head>`

export interface BookViewInput {
  /** the pay code of the link (a strict 22-character id) */
  code: string
  /** "$397.00" */
  money: string
  label: string
  minutes: number
  /** pre-filled when the link knows the person; the person may change them */
  name: string
  email: string
}

/** The script of the BOOK view. It only talks to this page's own two addresses (…/times and …/book) and to the card button below. */
function bookScript(code: string, money: string): string {
  // JSON for the script: "<" is written as < so no text can ever close the script tag
  const js = (v: string): string => JSON.stringify(v).replace(/</g, "\\u003c")
  return `(function(){
var CODE=${js(code)},MONEY=${js(money)};
var tz='America/New_York';try{tz=Intl.DateTimeFormat().resolvedOptions().timeZone||tz}catch(e){}
var byDay={},days=[],day=null,chosen=null,busy=false;
function $(i){return document.getElementById(i)}
function say(t){$('msg').textContent=t||''}
function fmt(o,d){return new Intl.DateTimeFormat('en-US',Object.assign({timeZone:tz},o)).format(d)}
function key(d){return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)}
function ready(){var n=$('name').value.trim(),e=$('email').value.trim();$('go').disabled=busy||!chosen||!n||!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(e)}
function showTimes(){var box=$('times');box.innerHTML='';(byDay[day]||[]).forEach(function(s){var b=document.createElement('button');b.type='button';b.textContent=fmt({hour:'numeric',minute:'2-digit'},new Date(s));if(s===chosen)b.className='on';b.onclick=function(){chosen=s;showTimes();ready()};box.appendChild(b)})}
function showDays(){var box=$('days');box.innerHTML='';days.forEach(function(k){var b=document.createElement('button');b.type='button';b.textContent=fmt({weekday:'short',month:'short',day:'numeric'},new Date(byDay[k][0]));if(k===day)b.className='on';b.onclick=function(){day=k;chosen=null;showDays();showTimes();ready()};box.appendChild(b)})}
function load(){say('');$('days').textContent='Loading free times…';$('times').innerHTML='';
fetch('/pay/b/'+CODE+'/times',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
if(!j.ok){$('days').textContent='';say(j.message||'Please try again.');if(j.reason==='booked'||j.reason==='paid')location.reload();return}
byDay={};days=[];j.slots.forEach(function(s){var k=key(new Date(s));if(!byDay[k]){byDay[k]=[];days.push(k)}byDay[k].push(s)});
chosen=null;day=days[0]||null;if(!day){$('days').textContent='';say('No free times are available right now. Please try again later.');return}
$('days').textContent='';showDays();showTimes();ready()}).catch(function(){$('days').textContent='';say('The calendar could not be reached. Please try again in a moment.')})}
$('name').oninput=ready;$('email').oninput=ready;
$('go').onclick=function(){if(busy||!chosen)return;busy=true;ready();say('');$('go').textContent='Booking your call…';
fetch('/pay/b/'+CODE+'/book',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({start:chosen,name:$('name').value,email:$('email').value,timezone:tz})}).then(function(r){return r.json()}).then(function(j){
if(j.ok){$('go').textContent='Booked. Opening the card page…';$('payform').submit();return}
busy=false;$('go').textContent='Book and pay '+MONEY;say(j.message||'Please try again.');
if(j.reason==='taken')load();else if(j.reason==='booked'||j.reason==='paid')location.reload();else ready()}).catch(function(){busy=false;$('go').textContent='Book and pay '+MONEY;say('Please try again in a moment.');ready()})};
load()})();`
}

/** The BOOK view: what is due, the free times, the person's details, one button. */
export function bookViewHtml(i: BookViewInput): string {
  return (
    `<div class="box"><div class="muted">Tony Durante LLC</div><div class="amt">${esc(i.money)}</div><div>${esc(i.label)}</div><div class="muted">${esc(String(i.minutes))}-minute video call</div></div>` +
    `<h2>1. Pick a time</h2><div class="muted">Times are shown in your own time zone.</div><div class="chips" id="days"></div><div class="chips" id="times"></div>` +
    `<h2>2. Your details</h2><input id="name" autocomplete="name" placeholder="Your name" maxlength="100" value="${esc(i.name)}"><input id="email" type="email" autocomplete="email" placeholder="Your email" maxlength="200" value="${esc(i.email)}">` +
    `<button id="go" type="button" disabled>Book and pay ${esc(i.money)}</button><div class="err" id="msg" role="alert"></div>` +
    `<p class="muted">Your call is booked as soon as you press the button, and you then pay by card on Stripe, our secure payment page. Nothing is charged until you confirm there.</p>` +
    `<form id="payform" method="post" action=""></form><noscript><p class="err">Please turn on JavaScript to pick a time.</p></noscript>` +
    `<script>${bookScript(i.code, i.money)}</script>`
  )
}
