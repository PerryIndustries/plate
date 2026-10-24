// Headless test of Plate's Moments: the wave screen and its follow-up, voice notes (fake mic), check-ins, Patterns, the opt-in backup and the two Claude opt-ins.
// Fixtures are bland on purpose: the repo is public.
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("C:/Users/Perry/hyperframes-student-kit/node_modules/playwright");
const DOCS = "C:/Users/Perry/plate/docs";
const URL0 = "http://localhost:8770/";

const server = http.createServer((req, res) => {
  const p = path.join(DOCS, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(p).pipe(res);
}).listen(8770);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra ?? ""); } };
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (!(await f())) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 100)); } return true; };

// fake GitHub contents API with sha semantics, plus DELETE. `big` paths answer the way GitHub does past 1 MB: JSON with an empty
// `content`, the bytes only under the raw Accept. `fail` injects failures: deletes answer 500, raw reads answer 500.
const repo = new Map();
let shaN = 1;
const big = new Set(), fail_ = { deletes: false, raw: false };
const b64 = (s) => Buffer.from(s).toString("base64");
const readJson = (k) => JSON.parse(Buffer.from(repo.get(k).content, "base64").toString());
const audioKeys = () => [...repo.keys()].filter((k) => k.startsWith("audio/"));
async function fakeGitHub(route) {
  const req = route.request(), url = new URL(req.url());
  const p = decodeURIComponent(url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ""));
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  if (req.method() === "PUT") {
    const body = JSON.parse(req.postData()), cur = repo.get(p);
    if (cur && body.sha !== cur.sha) return route.fulfill({ status: 409, headers: cors, body: "{}" });
    const sha = "s" + shaN++;
    repo.set(p, { content: body.content, sha });
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ content: { sha } }) });
  }
  if (req.method() === "DELETE") {
    if (fail_.deletes) return route.fulfill({ status: 500, headers: cors, body: "{}" });
    const body = JSON.parse(req.postData() || "{}"), cur = repo.get(p);
    if (!cur) return route.fulfill({ status: 404, headers: cors, body: "{}" });
    if (body.sha !== cur.sha) return route.fulfill({ status: 409, headers: cors, body: "{}" });
    repo.delete(p);
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: "{}" });
  }
  if (repo.has(p)) {
    const f = repo.get(p);
    if (/vnd\.github\.raw/.test(req.headers().accept || "")) {
      if (fail_.raw) return route.fulfill({ status: 500, headers: cors, body: "{}" });
      return route.fulfill({ status: 200, headers: cors, contentType: "application/octet-stream", body: Buffer.from(f.content, "base64") });
    }
    const body = Object.assign({ name: p.split("/").pop() }, f, big.has(p) ? { content: "", encoding: "none" } : {});
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
  }
  const kids = [...repo.keys()].filter((k) => k.startsWith(p + "/")).map((k) => ({ name: k.slice(p.length + 1), sha: repo.get(k).sha }));
  if (kids.length) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(kids) });
  return route.fulfill({ status: 404, headers: cors, body: "{}" });
}

// fake Claude: talks stream (SSE), the reflection is one plain-text message
const calls = [];
const sse = (events) => events.map(([ev, d]) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const streamBody = (text) => sse([
  ["message_start", { type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 2000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 50 } }],
  ["message_stop", { type: "message_stop" }],
]);
const REFLECTION = "A steady week. You named what came up and rode most of it out. One small thing to try: a short walk before bed.";
async function fakeClaude(route) {
  const req = route.request();
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const body = JSON.parse(req.postData());
  calls.push({ headers: req.headers(), body });
  if (body.stream === true) return route.fulfill({ status: 200, headers: Object.assign({ "content-type": "text/event-stream" }, cors), body: streamBody("I'm here. What's underneath it?") });
  return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({
    id: "msg_r", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
    content: [{ type: "text", text: REFLECTION }], usage: { input_tokens: 3000, output_tokens: 300 } }) });
}

(async () => {
  const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1208/chrome-win64/chrome.exe"),
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const errors = [];
  const mk = async (opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.grantPermissions(["microphone"]);
    const page = await ctx.newPage();
    if (opts.time) await page.clock.setFixedTime(opts.time);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.route("https://api.github.com/**", fakeGitHub);
    await page.route("https://api.anthropic.com/**", fakeClaude);
    return page;
  };
  // IndexedDB straight from the page: moments is plain JSON, audio blobs come back as {size, type}
  const idbGet = (page, k) => page.evaluate((k) => new Promise((res) => { const r = indexedDB.open("plate", 1); r.onsuccess = () => {
    const g = r.result.transaction("kv", "readonly").objectStore("kv").get(k); g.onsuccess = () => { const v = g.result; r.result.close(); res(v instanceof Blob ? { size: v.size, type: v.type } : v ?? null); }; }; }), k);
  const idbPut = (page, k, v) => page.evaluate(([k, v]) => new Promise((res) => { const r = indexedDB.open("plate", 1); r.onsuccess = () => {
    const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = () => { r.result.close(); res(); }; }; }), [k, v]);
  const hide = (page) => page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); });

  const page = await mk();
  const text = () => page.locator("#view").innerText();
  const moments = () => idbGet(page, "moments");
  const meta = () => idbGet(page, "meta");

  // the button: first thing on Today, and on Talk
  await page.goto(URL0 + "#/");
  await page.waitForSelector(".hero");
  ok(await page.evaluate(() => { const a = document.querySelector("#view").firstElementChild; return a && a.matches('a.wavebtn[href="#/wave"]') && /Riding a wave/.test(a.textContent); }), "wave button is the first thing on Today");
  await page.goto(URL0 + "#/talk");
  await page.waitForSelector('[data-act="newTalk"]');
  ok(await page.locator('a.wavebtn[href="#/wave"]').count() === 1, "wave button on #/talk too");
  ok((await text()).includes("Moments: nothing, unless you turn on the count summary"), "talk privacy card mentions Moments as off by default");
  await page.goto(URL0 + "#/me");
  await page.waitForSelector(".profile");
  ok(await page.locator('a[href="#/moments"]:has-text("Moments")').count() === 1, "Moments button on Progress");

  // open the wave screen and leave: nothing is created
  await page.goto(URL0 + "#/wave");
  await page.waitForSelector(".calm");
  const t0 = await text();
  ok(t0.includes("This is a wave.") && t0.includes("It will pass."), "calm headline");
  ok((await page.locator("#tabs a.on").getAttribute("data-tab")) === "today", "tab highlight on Today");
  ok(await page.locator(".pstep").count() === 5 && t0.includes("Name it: this is a wave") && t0.includes("Record a quick voice note") && t0.includes("Reach out: text someone or open Talk") && t0.includes("Change your surroundings") && t0.includes("Be kind to yourself whatever happens"), "five neutral default playbook steps", t0);
  ok(t0.includes("Set up someone to text") && await page.locator('a[href="#/talk/new"]').count() === 1, "reach step: contact link when unset, Open Talk");
  ok(await page.locator('.scale.ten [data-act="intensity"]').count() === 10 && await page.locator('input[type="range"]').count() === 0, "intensity is ten tap buttons, no slider");
  ok(!/ridden out|usually ease/.test(t0), "no history line before any wave");
  await page.goto(URL0 + "#/");
  await page.waitForSelector(".hero");
  ok(((await moments()) || { waves: [] }).waves.length === 0, "leaving untouched creates nothing");

  // name a wave: chips, intensity buttons, text, steps; everything persists across a reload
  await page.goto(URL0 + "#/wave");
  await page.waitForSelector(".calm");
  await page.click('.chip[data-k="feelings"][data-v="worried"]');
  await page.click('.chip[data-k="feelings"][data-v="tired"]');
  await page.click('[data-act="intensity"][data-v="7"]');
  ok((await page.locator("#intVal").innerText()) === "7" && (await page.locator('[data-act="intensity"].on').getAttribute("data-v")) === "7", "intensity tap shows live and lights its button");
  await page.click('.chip[data-k="triggers"][data-v="late at night"]');
  await page.fill('input[data-wave="text"]', "long day, nothing specific");
  await page.click('[data-act="step"][data-k="name"]');
  await page.click('[data-act="step"][data-k="reach"]');
  await page.waitForTimeout(600);   // debounce
  const m1 = await moments();
  ok(m1.waves.length === 1, "one wave stored once touched");
  const w1 = m1.waves[0];
  ok(w1.feelings.join() === "worried,tired" && w1.intensity === 7 && w1.triggers.join() === "late at night" && w1.text === "long day, nothing specific" && w1.steps.join() === "name,reach" && w1.follow === null && w1.asked === false && typeof w1.at === "number" && w1.u >= w1.at, "wave fields", w1);
  await page.reload();
  await page.waitForSelector(".calm");
  ok(await page.locator('.chip.on[data-k="feelings"]').count() === 2 && (await page.locator('[data-act="intensity"].on').getAttribute("data-v")) === "7" && (await page.inputValue('input[data-wave="text"]')) === "long day, nothing specific" && await page.locator(".pstep.done").count() === 2, "the same wave comes back after a reload");
  ok(((await moments()).waves.length) === 1, "reload reopens it instead of starting a second one");

  // voice note: records with the fake mic, lives in IndexedDB, plays from an object URL; delete + undo
  await page.click('[data-act="rec"]');
  await page.waitForSelector('[data-act="rec"].recording');
  ok(/Stop ·\s*[12]:\d\d/.test(await page.locator('[data-act="rec"]').innerText()), "recording shows a 2:00 countdown", await page.locator('[data-act="rec"]').innerText());
  await page.waitForTimeout(1200);
  await page.click('[data-act="rec"]');
  await page.waitForSelector("audio[data-audio]", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector("audio[data-audio]").src.startsWith("blob:"));
  const m2 = await moments();
  const aid = m2.waves[0].audio[0];
  const blob = await idbGet(page, "audio:" + aid);
  ok(m2.waves[0].audio.length === 1 && blob && blob.size > 0 && /^audio\/(mp4|webm)/.test(blob.type), "voice note stored as a blob", blob);
  ok(m2.waves[0].steps.includes("voice"), "recording ticks the voice step");
  ok(!(await page.evaluate(() => (localStorage.length || 0))), "nothing in localStorage");
  await page.click('[data-act="dropAudio"]');
  await page.waitForFunction(() => !document.querySelector("audio[data-audio]"));
  ok((await idbGet(page, "audio:" + aid)) === null, "deleting a note removes the blob");
  await page.click("#toastBtn");
  await page.waitForSelector("audio[data-audio]");
  ok((await idbGet(page, "audio:" + aid)).size === blob.size, "undo puts the blob back");
  ok(await page.locator("audio[data-audio]").count() === 1, "one note again");
  await page.screenshot({ path: path.join(__dirname, "wave.png"), fullPage: true });

  // follow-up: 15+ minutes later the app asks once, from Today only; then Today keeps a card until it's answered
  const m3 = await moments();
  m3.waves[0].at = Date.now() - 16 * 60e3;
  await idbPut(page, "moments", m3);
  await page.goto(URL0 + "#/moments");
  await page.reload();
  await page.waitForSelector("#checkin");
  await page.waitForTimeout(400);
  ok(page.url().endsWith("#/moments") && (await moments()).waves[0].asked === false, "a due follow-up doesn't yank him out of another screen");
  await page.goto(URL0 + "#/");
  await page.reload();
  await page.waitForFunction(() => location.hash.endsWith("/follow"), null, { timeout: 10000 });
  ok(page.url().includes("#/wave/" + w1.id + "/follow") && (await text()).includes("How's that wave now?"), "follow-up auto-opens from Today after 15 min");
  ok((await moments()).waves[0].asked === true, "asked flag set");
  await page.goto(URL0 + "#/");
  await page.waitForSelector(".hero");
  ok((await text()).includes("How's that wave now?") && await page.locator(`a[href="#/wave/${w1.id}/follow"]`).count() === 1, "Today card waits with an Answer link");
  await page.reload();
  await page.waitForSelector(".hero");
  ok(page.url().endsWith("#/") && (await text()).includes("How's that wave now?"), "asked only once; card stays");
  ok(await page.locator('[data-act="dismissFollow"]').count() === 1, "card has a dismiss");
  await page.goto(URL0 + "#/wave/" + w1.id);
  await page.waitForSelector('[data-act="deleteWave"]');
  const td = await text();
  ok(td.includes("Wave · 7/10") && td.includes("worried, tired") && td.includes("late at night") && td.includes("long day, nothing specific") && td.includes("No follow-up yet") && await page.locator("audio[data-audio]").count() === 1, "detail screen shows the wave", td);
  await page.click(`a[href="#/wave/${w1.id}/follow"]`);
  await page.waitForSelector('[data-act="fEnd"]');
  ok(await page.locator('[data-act="saveFollow"]').isDisabled(), "Save waits for an answer");
  ok(await page.locator('.scale.ten [data-act="fInt"]').count() === 10 && await page.locator('[data-act="fMins"]').count() === 6 && (await text()).includes("About how long did it last?"), "follow-up: ten intensity buttons and six duration chips");
  await page.click('[data-act="fEnd"][data-v="old"]');
  await page.waitForSelector('[data-act="fEnd"][data-v="old"].on');
  ok((await text()).includes("It went the usual way") && (await text()).includes("Noted, no shame. You tried 3 steps first."), "the usual-way answer: neutral copy with the step count", await text());
  await page.click('[data-act="fEnd"][data-v="passed"]');
  await page.waitForSelector('[data-act="fEnd"][data-v="passed"].on');
  await page.click('[data-act="fInt"][data-v="2"]');
  ok((await page.locator("#intVal").innerText()) === "2", "intensity-now tap shows live");
  await page.click('[data-act="fMins"][data-v="20"]');
  await page.click('[data-act="fHelp"][data-k="voice"]');
  await page.fill('input[data-fbind="other"]', "a glass of water");
  // the half-answered form survives the app being backgrounded and reopened
  await hide(page);
  await page.reload();
  await page.waitForSelector('[data-act="fEnd"]');
  ok(await page.locator('[data-act="fEnd"][data-v="passed"].on').count() === 1 && (await page.locator('[data-act="fInt"].on').getAttribute("data-v")) === "2" && await page.locator('[data-act="fMins"][data-v="20"].on').count() === 1 && await page.locator('[data-act="fHelp"][data-k="voice"].on').count() === 1 && (await page.inputValue('input[data-fbind="other"]')) === "a glass of water", "follow-up draft survives a reload");
  await page.click('[data-act="saveFollow"]');
  await page.waitForSelector('[data-act="deleteWave"]');
  const f1 = (await moments()).waves[0].follow;
  ok(f1 && f1.ended === "passed" && f1.intensity === 2 && f1.mins === 20 && f1.helped.join("|") === "voice|a glass of water" && f1.at - m3.waves[0].at > 15 * 60e3, "follow saved with mins", f1);
  ok((await idbGet(page, "fdraft")) === null, "draft cleared once saved");
  ok((await text()).includes("It passed") && (await text()).includes("about 20 min") && (await text()).includes("7 → 2") && (await text()).includes("Helped: a voice note, a glass of water"), "detail shows the follow-up with his duration", await text());
  await page.goto(URL0 + "#/");
  await page.waitForSelector(".hero");
  ok(!(await text()).includes("How's that wave now?"), "Today card gone once answered");

  // the history line uses what he said, not the clock
  await page.goto(URL0 + "#/wave");
  await page.waitForSelector(".calm");
  const th = await text();
  ok(th.includes("You've ridden out 1 wave.") && th.includes("usually ease in about 20 min"), "history line: ridden out + his minutes", th);
  ok(((await moments()).waves.length) === 1, "a wave with a follow-up isn't reopened");

  // zero-step copy on a second, bare wave
  await page.click('.chip[data-k="feelings"][data-v="bored"]');
  await page.waitForTimeout(100);
  const m4 = await moments();
  ok(m4.waves.length === 2, "second wave created on first touch");
  const w2 = m4.waves.find((w) => w.id !== w1.id);
  await page.goto(URL0 + "#/wave/" + w2.id + "/follow");
  await page.waitForSelector('[data-act="fEnd"]');
  await page.click('[data-act="fEnd"][data-v="old"]');
  await page.waitForSelector('[data-act="fEnd"][data-v="old"].on');
  ok((await text()).includes("Noted, no shame. Naming it is a step."), "zero steps: naming it is a step");
  await page.click('[data-act="saveFollow"]');
  await page.waitForSelector('[data-act="deleteWave"]');
  ok((await text()).includes("It went the usual way") && (await text()).includes("Naming it is a step."), "detail keeps the neutral copy");
  ok((await moments()).waves.find((w) => w.id === w2.id).follow.mins === null, "no duration chosen stores null");

  // recording on an untouched wave makes it real; leaving the screen mid-recording stops the mic and keeps the note
  await page.goto(URL0 + "#/wave");
  await page.waitForSelector(".calm");
  await page.click('[data-act="rec"]');
  await page.waitForSelector('[data-act="rec"].recording');
  await page.waitForTimeout(300);
  const m4b = await moments();
  ok(m4b.waves.length === 3, "starting a recording creates the wave");
  const w3 = m4b.waves.find((w) => w.id !== w1.id && w.id !== w2.id);
  await page.waitForTimeout(900);
  await page.goto(URL0 + "#/");
  await page.waitForSelector(".hero");
  ok(await until(async () => ((await moments()).waves.find((w) => w.id === w3.id).audio || []).length === 1, 10000), "note saved to the wave by id after leaving");
  await page.waitForTimeout(300);
  ok(page.url().endsWith("#/") && await page.locator(".hero").count() === 1 && await page.locator(".calm").count() === 0, "Today was not redrawn as the wave screen");
  await page.goto(URL0 + "#/wave");
  await page.waitForSelector(".calm");
  ok(await page.locator('[data-act="rec"].recording').count() === 0 && await page.locator("audio[data-audio]").count() === 1, "recorder stopped; the note is on the wave");
  const m4c = await moments(), a3 = m4c.waves.find((w) => w.id === w3.id).audio[0];
  m4c.waves.find((w) => w.id === w3.id).at = Date.now() - 20 * 60e3;   // past the live window, so the detail screen (with Delete) shows
  await idbPut(page, "moments", m4c);
  await page.goto(URL0 + "#/wave/" + w3.id);
  await page.reload();
  await page.waitForSelector('[data-act="deleteWave"]');
  await page.click('[data-act="deleteWave"]');
  await page.click('[data-act="deleteWave"]');
  await page.waitForSelector("#checkin");
  ok((await moments()).waves.find((w) => w.id === w3.id).del === true && (await idbGet(page, "audio:" + a3)) === null, "that wave deleted to a tombstone, its note gone");

  // quick check-in: one tap on the number saves; "Noted" makes way after a few seconds
  await page.goto(URL0 + "#/moments");
  await page.waitForSelector("#checkin");
  ok((await page.locator("#tabs a.on").getAttribute("data-tab")) === "me", "Moments highlights the Progress tab");
  await page.click('#checkin .chip[data-v="tired"]');
  await page.click('#checkin [data-act="ciSave"][data-v="4"]');
  await page.waitForSelector('#checkin:has-text("Noted ✓")');
  const c1 = (await moments()).checkins;
  ok(c1.length === 1 && c1[0].overall === 4 && c1[0].feelings.join() === "tired" && typeof c1[0].at === "number", "check-in saved on the number tap", c1);
  const th2 = await text();
  ok(th2.includes("worried, tired") && th2.includes("passed · 20 min") && th2.includes("went the usual way"), "recent waves listed with how they ended", th2);
  await page.waitForFunction(() => !document.querySelector("#checkin").textContent.includes("Noted ✓"), null, { timeout: 7000 });
  ok(await page.locator('#checkin [data-act="ciSave"]').count() === 5, "Noted clears after ~4 s");

  // night card: inside the window only, dismissable for the night
  const night = new Date(); night.setHours(23, 30, 0, 0);
  const day = new Date(); day.setHours(15, 0, 0, 0);
  const pn = await mk({ time: night });
  await pn.goto(URL0 + "#/");
  await pn.waitForSelector(".hero");
  ok(await pn.locator('#checkin:has-text("before bed")').count() === 1, "night check-in card at 23:30");
  await pn.click('#checkin [data-act="ciSave"][data-v="3"]');
  await pn.waitForFunction(() => !document.querySelector("#checkin"));
  ok(true, "card gone after a check-in");
  await pn.reload();
  await pn.waitForSelector(".hero");
  ok(await pn.locator("#checkin").count() === 0, "stays gone (check-in in the last 6 h)");
  const pn2 = await mk({ time: night });
  await pn2.goto(URL0 + "#/");
  await pn2.waitForSelector("#checkin");
  await pn2.click('[data-act="dismissCheckin"]');
  await pn2.waitForFunction(() => !document.querySelector("#checkin"));
  await pn2.reload();
  await pn2.waitForSelector(".hero");
  ok(await pn2.locator("#checkin").count() === 0, "dismiss hides it for the night");
  const pd = await mk({ time: day });
  await pd.goto(URL0 + "#/");
  await pd.waitForSelector(".hero");
  ok(await pd.locator("#checkin").count() === 0, "no night card at 15:00");
  for (const p of [pn, pn2, pd]) await p.context().close();

  // Patterns on seeded data (a fresh phone), lined up with a workout and a logged day
  const pp = await mk();
  await pp.goto(URL0 + "#/");
  await pp.waitForSelector(".hero");
  // nothing seeded on today or yesterday: the run may be after midnight, when the food day is still "yesterday", and Patterns leaves today out
  const at = (daysAgo, hour) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 20, 0, 0); return d.getTime(); };
  const wave = (id, daysAgo, hour, o) => Object.assign({ id, at: at(daysAgo, hour), feelings: ["worried"], intensity: 6, triggers: ["late at night"], text: "seed " + id, audio: [], steps: ["name", "voice"], follow: { at: at(daysAgo, hour) + 20 * 60e3, intensity: 2, ended: "passed", helped: ["voice"] }, asked: true, dismissed: false, u: 1, del: false }, o);
  const seeded = { waves: [
    wave("s1", 2, 23), wave("s2", 4, 1, { triggers: ["scrolling"], follow: null }), wave("s3", 7, 1, { steps: ["name"], follow: { at: at(7, 1) + 40 * 60e3, intensity: 6, ended: "old", helped: [] } }),
    wave("s4", 10, 15, { feelings: ["bored"], follow: { at: at(10, 15) + 20 * 60e3, intensity: 2, ended: "passed", helped: ["voice"], mins: 45 } }),   // his answer (45) beats the clock (20)
    wave("s5", 14, 23, { steps: ["voice"], follow: { at: at(14, 23) + 30 * 60e3, intensity: 3, ended: "easing", helped: ["voice", "move"] } }),
    wave("s6", 21, 1), wave("s7", 28, 1, { triggers: ["bored"], steps: ["voice"], follow: { at: at(28, 1) + 60 * 60e3, intensity: 5, ended: "still", helped: [] } }), wave("s8", 35, 23),
    wave("s9", 17, 9, { triggers: [], steps: [], follow: { at: at(17, 9) + 3 * 3600e3, intensity: 1, ended: "passed", helped: [] } }),   // answered 3 h later, no minutes given: ridden out, but no time
    { id: "gone", u: 1, del: true },
  ], checkins: [{ id: "c1", at: at(2, 22), feelings: ["tired"], overall: 3, u: 1, del: false }, { id: "c2", at: at(9, 22), feelings: ["happy"], overall: 4, u: 1, del: false }],
  habits: [], wins: [], reflections: [], lists: { feelings: ["worried", "bored", "tired", "happy"], triggers: ["late at night", "scrolling", "bored"], habits: ["A rest night"], u: 1 } };
  await idbPut(pp, "moments", seeded);
  const dayOf = (ms) => { const d = new Date(ms - 4 * 3600e3); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const d1 = dayOf(at(2, 23)), d4 = dayOf(at(10, 15));
  await idbPut(pp, "workouts", [{ id: "wk1", date: d1, templateId: "split0", name: "Upper A", startedAt: at(2, 17), endedAt: at(2, 18), note: "", u: 1, exercises: [] }]);
  await idbPut(pp, "day:" + d4, { date: d4, entries: [{ id: "e1", time: "12:00", title: "Lunch", cal: 600, p: 40, c: 50, f: 20, fiber: 5, src: "manual" }], steps: { n: 10000, u: 1 } });
  await pp.goto(URL0 + "#/patterns");
  await pp.reload();
  await pp.waitForSelector("svg.bars");
  const tp = await pp.locator("#view").innerText();
  ok(await pp.locator("svg.bars rect").count() === 8, "eight weekly bars");
  ok(tp.includes("You've named 9 waves, followed up on 8 and ridden out 6."), "showing-up line counts live waves only", tp);
  ok(/late night 12–4\s+4 waves/.test(tp) && /evening\s+3 waves/.test(tp) && /afternoon\s+1 wave\b/.test(tp) && /morning\s+1 wave\b/.test(tp), "time-of-day buckets (late night ends at dayStart)", tp);
  ok(/What set them off\s+late at night\s+6×/.test(tp), "top trigger", tp);
  ok(/a voice note · tried 7× · eased 5 of 7 · about 20 min · you said it helped 5×/.test(tp) && /naming it · tried 6× · eased 4 of 6/.test(tp), "per-step help rate and minutes", tp);
  ok(/Half of your eased waves were done within\s*20 min/.test(tp) && tp.includes("from 5 waves with a time"), "median time to ease: his minutes first, late answers left out", tp);
  ok(/Sleep isn't tracked in Plate/.test(tp) && tp.includes("not counting today"), "honest about sleep; today left out");
  ok(/Days with a workout\s+1\.0 \(1 d\) · without 0\.\d \(\d+ d\)/.test(tp) && /Days with food logged\s+1\.0 \(1 d\)/.test(tp) && /Days with steps at goal\s+1\.0 \(1 d\)/.test(tp), "lined up with workouts, food and steps", tp);
  ok(/Mood check-ins/.test(tp) && /3\.0 \/ 5/.test(tp) && /4\.0 \/ 5/.test(tp), "weekly check-in averages", tp);
  ok(tp.includes("1 wave went the usual way") && !tp.includes("seed s1"), "warm framing, no free text", tp);
  await pp.screenshot({ path: path.join(__dirname, "patterns.png"), fullPage: true });
  await pp.goto(URL0 + "#/moments");
  await pp.waitForSelector("#checkin");
  ok(!(await pp.locator("#view").innerText()).includes("gone"), "tombstones don't show");
  ok(((await idbGet(pp, "moments")).lists.steps || []).length === 5, "lists saved before the playbook was editable get the default steps");
  await pp.context().close();

  // backup OFF: a token backs up everything else, but nothing from Moments
  await page.goto(URL0 + "#/settings");
  await page.fill('input[data-set="apiKey"]', "sk-ant-test");
  await page.locator('input[data-set="apiKey"]').blur();
  await page.fill('input[data-set="token"]', "github_pat_test");
  await page.locator('input[data-set="token"]').blur();
  await page.waitForFunction(() => /Backed up|failed/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  ok((await page.locator("#syncStatus").innerText()).startsWith("Backed up"), "backup ran");
  ok(!repo.has("moments.json") && audioKeys().length === 0 && ![...repo.values()].some((v) => Buffer.from(v.content, "base64").toString().includes("nothing specific")), "backup off: no moments.json, no audio, no wave text anywhere", [...repo.keys()]);
  await page.evaluate(() => { window.__blob = null; const real = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { if (b.type === "application/json") window.__blob = b; return real(b); }; HTMLAnchorElement.prototype.click = function () {}; Object.defineProperty(navigator, "canShare", { value: undefined, configurable: true }); });
  await page.click('[data-act="export"]');
  await page.waitForFunction(() => !!window.__blob);
  const exp1 = await page.evaluate(() => window.__blob.text());
  ok(!("moments" in JSON.parse(exp1)) && !exp1.includes("nothing specific"), "export leaves Moments out while backup is off");
  await page.goto(URL0 + "#/moments");
  await page.waitForSelector('input[data-set="momentsBackup"]');
  ok(await page.locator('input[data-set="momentsAudioBackup"]').isDisabled() && await page.locator('[data-act="removeMomentsBackup"]').count() === 0, "audio switch disabled until backup is on; no remove button yet");
  const priv = await text();
  ok(priv.includes("stays on this phone unless you turn on backup") && priv.includes("Never the lines you type, never the recordings") && priv.includes('"Download everything" (without audio) only when backup is on'), "privacy card in plain words", priv);
  ok(priv.includes("GitHub keeps older versions in that repo's git history") && priv.includes("Deleting and re-creating that private repo on GitHub clears them completely"), "privacy card is honest about git history", priv);

  // backup ON: moments.json without audio
  await page.check('input[data-set="momentsBackup"]');
  ok(await until(() => repo.has("moments.json")), "moments.json written once backup is on");
  const mj = readJson("moments.json");
  ok(mj.waves.length === 3 && mj.waves.some((w) => w.text === "long day, nothing specific") && mj.checkins.length === 1 && Array.isArray(mj.habits) && Array.isArray(mj.wins) && mj.lists.feelings.includes("worried") && mj.lists.steps.length === 5 && !("reflections" in mj), "moments.json shape: waves, checkins, habits, wins, lists (with steps); no reflections", Object.keys(mj));
  await page.waitForTimeout(500);
  ok(audioKeys().length === 0, "no audio without the second switch");
  await page.goto(URL0 + "#/settings");
  await page.waitForSelector('[data-act="export"]');
  await page.evaluate(() => { window.__blob = null; });
  await page.click('[data-act="export"]');
  await page.waitForFunction(() => !!window.__blob);
  const exp2 = JSON.parse(await page.evaluate(() => window.__blob.text()));
  ok(exp2.moments && exp2.moments.waves.length === 3 && !("reflections" in exp2.moments) && !Object.keys(exp2).some((k) => k.startsWith("audio")), "export includes Moments (no audio) once backup is on");

  // audio backup ON: the note goes up under audio/<id>.<ext>
  await page.goto(URL0 + "#/moments");
  await page.waitForSelector('input[data-set="momentsAudioBackup"]:not([disabled])');
  await page.check('input[data-set="momentsAudioBackup"]');
  ok(await until(() => audioKeys().length === 1), "voice note uploaded", audioKeys());
  ok(new RegExp("^audio/" + aid + "\\.(m4a|webm)$").test(audioKeys()[0] || ""), "audio file named by id", audioKeys());

  // deleting a note removes it from the repo; undo cancels that (or puts it back)
  await page.goto(URL0 + "#/wave/" + w1.id);
  await page.waitForSelector('[data-act="dropAudio"]');
  await page.click('[data-act="dropAudio"]');
  ok(await until(() => audioKeys().length === 0), "deleted voice note removed from the repo", audioKeys());
  await page.click("#toastBtn");
  await page.waitForSelector("audio[data-audio]");
  ok(await until(() => audioKeys().length === 1, 15000) && (await meta()).remoteDeletes.length === 0, "undo: note back in the repo, nothing left to delete", audioKeys());

  // backup OFF again: offers removal; a failing repo keeps the request queued and says so; the next backup finishes the job
  await page.goto(URL0 + "#/moments");
  await page.waitForSelector('input[data-set="momentsBackup"]');
  await page.uncheck('input[data-set="momentsBackup"]');
  await page.waitForSelector('[data-act="removeMomentsBackup"]');
  ok(!(await page.locator('input[data-set="momentsAudioBackup"]').isChecked()) && await page.locator('input[data-set="momentsAudioBackup"]').isDisabled(), "turning backup off takes the audio switch with it");
  await page.click('[data-act="removeMomentsBackup"]');
  ok((await page.locator('[data-act="removeMomentsBackup"]').innerText()).includes("Tap again") && (await page.locator('[data-act="removeMomentsBackup"]').innerText()).includes("git history") && repo.has("moments.json"), "first tap only arms, and names the history caveat");
  fail_.deletes = true;
  await page.click('[data-act="removeMomentsBackup"]');
  await page.waitForFunction(() => /couldn't be removed/.test(document.getElementById("toastText").textContent), null, { timeout: 10000 });
  await page.waitForSelector('.error:has-text("will retry")');
  const mt1 = await meta();
  ok(repo.has("moments.json") && audioKeys().length === 1 && mt1.momentsSynced === 1 && mt1.remoteDeletes.includes("moments.json") && mt1.remoteDeletes.includes("audio/*") && await page.locator('[data-act="removeMomentsBackup"]').count() === 1, "failed removal: still synced, queued, button and status stay", mt1.remoteDeletes);
  fail_.deletes = false;
  await page.goto(URL0 + "#/settings");
  await page.click('[data-act="sync"]');
  ok(await until(() => !repo.has("moments.json") && audioKeys().length === 0), "the next backup retries: moments.json and audio/* removed from the repo", [...repo.keys()]);
  await page.waitForFunction(() => /Backed up/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  const mt2 = await meta();
  ok(mt2.remoteDeletes.length === 0 && mt2.momentsSynced === 0, "queue drained, synced flag cleared only now", mt2);
  await page.goto(URL0 + "#/moments");
  await page.waitForSelector('input[data-set="momentsBackup"]');
  ok(await page.locator('[data-act="removeMomentsBackup"]').count() === 0 && await page.locator('.error:has-text("will retry")').count() === 0, "remove button and status gone once the repo confirms");
  ok((await moments()).waves.length === 3, "the phone keeps its copy");
  await page.check('input[data-set="momentsBackup"]');
  ok(await until(() => repo.has("moments.json")), "back on: moments.json again");
  await page.waitForSelector('input[data-set="momentsAudioBackup"]:not([disabled])');
  await page.check('input[data-set="momentsAudioBackup"]');
  ok(await until(() => audioKeys().length === 1), "audio re-uploaded when the switch comes back");

  // talkMoments off: a new talk's system has nothing from Moments; on: a 14-day count summary, no free text; older talks never pick it up
  const send = async (msg) => { await page.fill("#talkIn", msg); await page.click('[data-act="send"]'); await page.waitForSelector(".msg.a", { timeout: 30000 }); await page.waitForFunction(() => { const b = document.querySelector('[data-act="send"]'); return b && !b.disabled; }, null, { timeout: 30000 }); };
  await page.goto(URL0 + "#/talk/new");
  await page.waitForSelector("#talkIn");
  await send("quick one");
  const s1 = calls[calls.length - 1].body.system;
  ok(!/Moments/.test(s1) && s1.endsWith("\n\nNo notes from past talks yet."), "talkMoments off: nothing from Moments in the system");
  await page.goto(URL0 + "#/moments");
  await page.waitForSelector('input[data-set="talkMoments"]');
  await page.check('input[data-set="talkMoments"]');
  await page.goto(URL0 + "#/talk");
  await page.waitForSelector('[data-act="newTalk"]:not([disabled])');
  ok((await text()).includes("a 14-day count summary, never your lines or recordings"), "talk privacy card says the summary is on");
  await page.click('[data-act="newTalk"]');
  await page.waitForSelector("#talkIn");
  await send("another");
  const s2 = calls[calls.length - 1].body.system;
  ok(s2.includes("From his Moments log in the app (counts and the short labels he tapped") && s2.includes("Moments in Plate, last 14 days") && /- Waves: 2 \(1 passed, 0 easing, 0 still there at follow-up, 1 went the usual way, 0 without a follow-up\); the ones that eased took about 20 min\./.test(s2) && s2.includes("worried ×1") && s2.includes("late at night ×1") && s2.includes("Mood check-ins: 1, average 4.0 of 5"), "talkMoments on: counts in a new talk's system", s2.slice(s2.indexOf("Moments in Plate")));
  ok(!s2.includes("nothing specific") && !s2.includes("glass of water") && !s2.includes(aid), "no wave text, no follow-up free text, no audio id");
  ok(!s2.includes("Weekly habits"), "talk summary leaves habits out");
  const talks = await idbGet(page, "talks");
  talks.push({ id: "legacy", title: "from before", at: Date.now() - 864e5, u: Date.now() - 864e5, messages: [{ role: "user", text: "hi", at: 1 }, { role: "assistant", text: "hey", at: 2 }], usd: 0, notesSaved: 0, notes: "", about: "" });
  await idbPut(page, "talks", talks);
  await page.goto(URL0 + "#/talk/legacy");
  await page.reload();
  await page.waitForSelector("#talkIn");
  await send("picking this back up");
  const s3 = calls[calls.length - 1].body.system;
  ok(!s3.includes("Moments") && s3.endsWith("\n\nNo notes from past talks yet."), "a talk from before the switch stays byte-identical: no summary added mid-talk");

  // weekly reflection: preview first, counts only, one plain call, cost shown, kept on the phone
  await page.goto(URL0 + "#/patterns");
  await page.waitForSelector('[data-act="openReflection"]');
  await page.click('[data-act="openReflection"]');
  await page.waitForSelector('[data-act="askReflection"]');
  await page.click("details summary");
  const preview = await page.locator("details pre.notes").evaluate((el) => el.textContent);
  ok(preview.includes("Moments in Plate, last 7 days") && preview.includes("- Waves: 2") && preview.includes("Weekly habits ticked this week: 0 of 3") && preview.includes("Wins written down: 0") && !preview.includes("nothing specific"), "preview shows exactly the counts", preview);
  const nBefore = calls.length;
  await page.click('[data-act="askReflection"]');
  await page.waitForSelector('.msg.a:has-text("A steady week")', { timeout: 30000 });
  const rc = calls[calls.length - 1];
  ok(calls.length === nBefore + 1 && rc.body.stream !== true && rc.body.model === "claude-opus-5-5" && rc.body.fallbacks === "default" && rc.body.output_config.effort === "medium" && !rc.body.output_config.format, "one plain non-streaming call");
  ok(rc.body.system.startsWith("You are Perry's friend who is also a mentor.") && !rc.body.system.includes("Moments in Plate"), "TALK_SYSTEM as the system prompt, counts only in the user turn");
  ok(rc.body.messages.length === 1 && rc.body.messages[0].content === preview, "the user message is byte-for-byte the preview");
  ok(!rc.body.messages[0].content.includes("nothing specific") && !rc.body.messages[0].content.includes("glass of water"), "reflection carries no wave text");
  ok((await text()).includes("≈ 2¢"), "cost shown (3000 in, 300 out)", await text());
  const rf = (await moments()).reflections;
  ok(rf.length === 1 && rf[0].text === REFLECTION && rf[0].usd > 0.017 && rf[0].usd < 0.019 && /^\d{4}-\d{2}-\d{2}$/.test(rf[0].week), "reflection kept locally", rf);
  await page.goto(URL0 + "#/settings");
  await page.click('[data-act="sync"]');
  await page.waitForFunction(() => /Backed up/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  ok(!("reflections" in readJson("moments.json")) && !Buffer.from(repo.get("moments.json").content, "base64").toString().includes("steady week"), "reflections never reach the repo");
  await page.goto(URL0 + "#/patterns");
  await page.waitForSelector("svg.bars");
  ok((await text()).includes("Past reflections (1, on this phone only)"), "past reflections listed");

  // habits + today's win persist; week is that week's Monday
  await page.goto(URL0 + "#/moments");
  await page.waitForSelector("#winIn");
  await page.click('input[data-act="habit"] >> nth=0');
  await page.fill("#winIn", "Called someone back");
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector("#winIn");
  ok(await page.locator('input[data-act="habit"] >> nth=0').isChecked() && (await page.inputValue("#winIn")) === "Called someone back", "habit tick and win survive a reload");
  const m5 = await moments();
  const monday = await page.evaluate(() => { const d = new Date(Date.now() - 4 * 3600e3); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); });
  ok(m5.habits.length === 1 && m5.habits[0].week === monday && m5.habits[0].key === "share-something-you-care-about-with-someone" && !m5.habits[0].del, "habit tick shape", m5.habits);
  ok(m5.wins.length === 1 && m5.wins[0].text === "Called someone back" && /^\d{4}-\d{2}-\d{2}$/.test(m5.wins[0].date), "win shape", m5.wins);
  ok((await text()).includes("1 tick · 1 win written down"), "week summary line");
  await page.click('input[data-act="habit"] >> nth=0');
  await page.waitForTimeout(100);
  ok((await moments()).habits[0].del === true, "unticking soft-deletes the tick");

  // lists: add + remove, persist, reach the wave screen; the playbook is a list too
  await page.fill('input[data-ladd="feelings"]', "calm");
  await page.press('input[data-ladd="feelings"]', "Enter");
  await page.waitForSelector('.chip:has-text("calm")');
  await page.click('[data-act="dropList"][data-l="feelings"][data-v="bored"]');
  await page.fill('input[data-ladd="triggers"]', "skipped a meal");
  await page.click('[data-act="addList"][data-l="triggers"]');
  await page.waitForSelector('.chip:has-text("skipped a meal")');
  await page.fill('input[data-ladd="steps"]', "Drink a glass of water");
  await page.press('input[data-ladd="steps"]', "Enter");
  await page.waitForSelector('[data-act="dropStep"][data-k="s-drink-a-glass-of-water"]');
  await page.click('[data-act="dropStep"][data-k="move"]');
  await page.waitForFunction(() => !document.querySelector('[data-act="dropStep"][data-k="move"]'));
  await page.reload();
  await page.waitForSelector("#winIn");
  const L = (await moments()).lists;
  ok(L.feelings.includes("calm") && !L.feelings.includes("bored") && L.triggers.includes("skipped a meal") && L.triggers.includes("bored") && L.u > 0, "lists edited and saved", L);
  ok(L.steps.map((s) => s.key).join() === "name,voice,reach,noshame,s-drink-a-glass-of-water" && L.steps[4].label === "Drink a glass of water", "playbook edited: built-in keys kept, new step gets its own key", L.steps);
  await page.fill('input[data-set="waveContactName"]', "Sam");
  await page.locator('input[data-set="waveContactName"]').blur();
  await page.fill('input[data-set="waveContactPhone"]', "+1 555 0100");
  await page.locator('input[data-set="waveContactPhone"]').blur();
  await page.goto(URL0 + "#/wave");
  await page.waitForSelector(".calm");
  ok(await page.locator('.chip[data-k="feelings"][data-v="calm"]').count() === 1 && await page.locator('.chip[data-k="feelings"][data-v="bored"]').count() === 0 && await page.locator('.chip[data-k="triggers"][data-v="skipped a meal"]').count() === 1, "wave screen uses the edited lists");
  const tw = await text();
  ok(await page.locator(".pstep").count() === 5 && tw.includes("5. Drink a glass of water") && !tw.includes("Change your surroundings") && await page.locator('.pstep:has([data-k="voice"]) [data-act="rec"]').count() === 1 && await page.locator('.pstep:has([data-k="reach"]) a[href^="sms:"]').count() === 1, "wave screen uses the edited playbook; recorder and Text button stay with their steps", tw);
  const sms = page.locator('a[href^="sms:"]');
  ok(await sms.count() === 1 && (await sms.getAttribute("href")) === "sms:+15550100" && (await sms.innerText()) === "Text Sam", "Text button dials the contact");
  await page.goto(URL0 + "#/wave/" + w1.id + "/follow");
  await page.waitForSelector('[data-act="fHelp"]');
  ok(await page.locator('[data-act="fHelp"][data-k="s-drink-a-glass-of-water"]').count() === 1 && await page.locator('[data-act="fHelp"][data-k="move"]').count() === 0, "follow-up offers the current playbook");
  await page.goto(URL0 + "#/settings");
  await page.click('[data-act="sync"]');
  await page.waitForFunction(() => /Backed up/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  const all = [...repo.values()].map((v) => Buffer.from(v.content, "base64").toString()).join("\n");
  ok(!all.includes("5550100") && !all.includes("Sam") && readJson("moments.json").lists.feelings.includes("calm") && readJson("moments.json").lists.steps.length === 5, "contact never synced; lists (playbook included) are");

  // a second phone pulls it all back, voice note included, even when GitHub serves the file the >1 MB way (empty JSON content, bytes only raw)
  big.add(audioKeys()[0]);
  const p2 = await mk();
  await p2.goto(URL0 + "#/settings");
  await p2.fill('input[data-set="token"]', "github_pat_test");
  await p2.locator('input[data-set="token"]').blur();
  await p2.waitForFunction(() => /Backed up|failed/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  await p2.goto(URL0 + "#/moments");
  await p2.waitForSelector("#checkin");
  ok(!(await p2.locator("#view").innerText()).includes("worried, tired"), "a phone without the switch on pulls nothing from Moments");
  await p2.check('input[data-set="momentsBackup"]');
  await p2.waitForSelector('.wrow:has-text("worried, tired")', { timeout: 15000 });
  await p2.waitForSelector('input[data-set="momentsAudioBackup"]:not([disabled])');
  await p2.check('input[data-set="momentsAudioBackup"]');
  fail_.raw = true;
  await p2.click('.wrow:has-text("worried, tired")');
  await p2.waitForSelector('span:has-text("voice note not on this phone")', { timeout: 15000 });
  ok((await idbGet(p2, "audio:" + aid)) === null, "a failed pull caches nothing");
  fail_.raw = false;
  await p2.goto(URL0 + "#/moments");
  await p2.waitForSelector(".wrow");
  await p2.click('.wrow:has-text("worried, tired")');
  await p2.waitForSelector("audio[data-audio]");
  await p2.waitForFunction(() => document.querySelector("audio[data-audio]").src.startsWith("blob:"), null, { timeout: 15000 });
  const b2 = await idbGet(p2, "audio:" + aid);
  ok(b2 && b2.size === blob.size && b2.size > 0, "second phone restored the wave and its voice note as raw bytes on the retry", b2);
  await p2.context().close();

  // delete all with backup OFF but a copy in the repo: the files go anyway; lists and contact reset; a stale copy can't bring anything back
  await page.goto(URL0 + "#/moments");
  await page.waitForSelector('[data-act="deleteMoments"]');
  await page.screenshot({ path: path.join(__dirname, "moments.png"), fullPage: true });
  await page.uncheck('input[data-set="momentsBackup"]');
  await page.waitForSelector('[data-act="removeMomentsBackup"]');
  await page.click('[data-act="deleteMoments"]');
  ok((await page.locator('[data-act="deleteMoments"]').innerText()).includes("Tap again") && (await page.locator('[data-act="deleteMoments"]').innerText()).includes("in the backup") && (await moments()).waves.length === 3, "first delete-all tap only arms, and says the backup goes too");
  await page.click('[data-act="deleteMoments"]');
  await page.waitForSelector('.card:has-text("None logged")');
  const m6 = await moments();
  ok(m6.waves.length === 0 && m6.checkins.length === 0 && m6.habits.length === 0 && m6.wins.length === 0 && m6.reflections.length === 0, "local copy wiped", m6);
  ok(!m6.lists.feelings.includes("calm") && m6.lists.feelings.includes("bored") && !m6.lists.triggers.includes("skipped a meal") && m6.lists.steps.length === 5 && m6.lists.steps[3].key === "move", "lists back to the defaults", m6.lists);
  const st = await idbGet(page, "settings");
  ok(st.waveContactName === "" && st.waveContactPhone === "" && (await page.inputValue('input[data-set="waveContactName"]')) === "", "contact cleared");
  ok((await idbGet(page, "audio:" + aid)) === null, "audio blob gone");
  ok(await until(() => !repo.has("moments.json") && audioKeys().length === 0), "backup off, repo copy existed: moments.json and audio/* removed anyway", [...repo.keys()]);
  await page.waitForFunction(() => !document.querySelector('[data-act="removeMomentsBackup"]'));
  const mt3 = await meta();
  ok(mt3.momentsSynced === 0 && mt3.remoteDeletes.length === 0 && mt3.momentsWipedAt > 0, "synced flag cleared, wipe mark set", mt3);
  await page.reload();
  await page.waitForSelector("#checkin");
  ok((await text()).includes("None logged") && await page.locator('[data-act="deleteMoments"]').count() === 0, "still empty after reload");
  // another device's copy from before the wipe shows up in the repo; turning backup back on must not resurrect it
  const stale = { waves: [Object.assign({}, w1, { id: "stale1", text: "stale copy", u: mt3.momentsWipedAt - 1000 })], checkins: [], habits: [], wins: [], lists: { feelings: ["calm"], triggers: [], habits: [], steps: [], u: 5 } };
  repo.set("moments.json", { content: b64(JSON.stringify(stale)), sha: "stale" });
  await page.check('input[data-set="momentsBackup"]');
  ok(await until(() => repo.has("moments.json") && repo.get("moments.json").sha !== "stale" && readJson("moments.json").waves.every((w) => w.del && !w.text)), "re-enabling backup turns the stale repo copy into tombstones", repo.has("moments.json") && readJson("moments.json"));
  const m7 = await moments();
  ok(m7.waves.every((w) => w.del && !w.text) && m7.lists.feelings.includes("bored") && !m7.lists.feelings.includes("calm"), "nothing deleted comes back on the phone; default lists win over the stale ones", m7);
  await page.waitForSelector("#checkin");
  ok((await text()).includes("None logged"), "hub still empty");
  await page.goto(URL0 + "#/patterns");
  await page.waitForSelector("h1");
  ok((await text()).includes("Nothing to read yet, and that's fine."), "Patterns empty state is kind");

  ok(errors.filter((e) => !/status of (404|409|422|500)|ERR_ABORTED|net::ERR_FAILED/.test(e)).length === 0, "no page errors (404/409/500 are the fake backup answering)", errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
