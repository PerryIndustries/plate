// Headless test of Plate's Talk: streaming chat with a fake Claude (real SSE), frozen About + notes in the system prompt, wrap-up notes to a fake repo, privacy.
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("C:/Users/Perry/hyperframes-student-kit/node_modules/playwright");
const DOCS = "C:/Users/Perry/plate/docs";
const URL0 = "http://localhost:8769/";

const server = http.createServer((req, res) => {
  const p = path.join(DOCS, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(p).pipe(res);
}).listen(8769);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra ?? ""); } };
const b64 = (s) => Buffer.from(s).toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString();

// fake GitHub contents API, with real sha semantics: a PUT with a stale sha is a 409, a good one returns the new sha
const repo = new Map();
let shaN = 1, notesPutFail = null;   // notesPutFail: runs once before the next PUT to talk/notes.md, which then 409s (the PC saved first)
async function fakeGitHub(route) {
  const req = route.request(), url = new URL(req.url());
  const p = decodeURIComponent(url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ""));
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,PUT,OPTIONS" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  if (req.method() === "PUT") {
    const body = JSON.parse(req.postData()), cur = repo.get(p);
    if (p === "talk/notes.md" && notesPutFail) { const f = notesPutFail; notesPutFail = null; f(); return route.fulfill({ status: 409, headers: cors, body: "{}" }); }
    if (cur && body.sha !== cur.sha) return route.fulfill({ status: 409, headers: cors, body: "{}" });
    const sha = "s" + shaN++;
    repo.set(p, { content: body.content, sha });
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ content: { sha } }) });
  }
  if (repo.has(p)) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(Object.assign({ name: p.split("/").pop() }, repo.get(p))) });
  const kids = [...repo.keys()].filter((k) => k.startsWith(p + "/")).map((k) => ({ name: k.slice(p.length + 1) }));
  if (kids.length) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(kids) });
  return route.fulfill({ status: 404, headers: cors, body: "{}" });
}

// fake Claude: streaming chats get a real SSE body; the notes call gets a JSON message whose text is the structured output
const calls = [];
let reply = "I hear you. That sounds like a lot to carry this week. What part of it is weighing on you most right now?";
let nextStop = "end_turn", notesStop = "end_turn", failWith = 0, notesOut = null, hang = false;   // hang: the next chat call never answers (app gets closed mid-reply)
const sse = (events) => events.map(([ev, d]) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`).join("");
function streamBody(text, stop) {
  const chunks = text.match(/.{1,9}/g) || [];
  return sse([
    ["message_start", { type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 5000, output_tokens: 1, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ...chunks.map((c) => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: c } }]),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 400 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}
async function fakeClaude(route) {
  const req = route.request();
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const body = JSON.parse(req.postData());
  calls.push({ headers: req.headers(), body });
  if (failWith) return route.fulfill({ status: failWith, headers: cors, contentType: "application/json", body: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) });
  if (body.stream === true) {
    if (hang) { hang = false; return; }   // left pending on purpose
    await new Promise((r) => setTimeout(r, 600));   // the model thinks first: long enough to see the typing dots and the disabled Send
    const stop = nextStop; nextStop = "end_turn";
    return route.fulfill({ status: 200, headers: Object.assign({ "content-type": "text/event-stream" }, cors), body: streamBody(reply, stop) });
  }
  const prompt = body.messages[0].content;
  const cur = /Current notes:\n([\s\S]*?)\n\nConversation:/.exec(prompt)[1];
  const out = notesOut ? notesOut(cur) : { notes: cur.replace("## Patterns I've noticed\n", "## Patterns I've noticed\n- 2026-10-24: Likes long walks after work.\n"), summary: "Added a line about walks after work." };
  const stop = notesStop; notesStop = "end_turn";
  return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({
    id: "msg_n", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: stop,
    content: [{ type: "text", text: JSON.stringify(out) }], usage: { input_tokens: 3000, output_tokens: 300 } }) });
}
const notesCalls = () => calls.filter((c) => c.body.stream !== true);

(async () => {
  // the repo is public: nothing personal may live in the app or the tests. The words to look for are themselves
  // personal, so they live in tests/private-words.txt (one per line, gitignored, only on Perry's PC).
  const wordsFile = path.join(__dirname, "private-words.txt");
  if (fs.existsSync(wordsFile)) {
    const words = fs.readFileSync(wordsFile, "utf8").split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const files = ["../docs/index.html", "smoke.cjs", "progress.cjs", "workout.cjs", "talk.cjs", "moments.cjs", "../README.md"];
    const leaked = files.flatMap((f) => { const src = fs.readFileSync(path.join(__dirname, f), "utf8").toLowerCase(); return words.filter((w) => src.includes(w)).map((w) => f + ": " + w); });
    ok(leaked.length === 0, "no personal details in public files", leaked);
  } else console.log("SKIP personal-details check (no tests/private-words.txt)");

  const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1208/chrome-win64/chrome.exe") });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.route("https://api.github.com/**", fakeGitHub);
  await page.route("https://api.anthropic.com/**", fakeClaude);
  const text = () => page.locator("#view").innerText();
  const toastText = () => page.locator("#toastText").innerText();
  const blur = (sel) => page.locator(sel).blur();
  const send = async (msg, waitFor) => {
    await page.fill("#talkIn", msg);
    await page.click('[data-act="send"]');
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 30000 });
  };
  const sendEnabled = () => page.waitForFunction(() => { const b = document.querySelector('[data-act="send"]'); return b && !b.disabled; }, null, { timeout: 30000 });
  const notesFile = () => unb64(repo.get("talk/notes.md").content);

  // entry from Progress, privacy copy, no-key state
  await page.goto(URL0 + "#/me");
  await page.waitForSelector(".profile");
  await page.click('a[href="#/talk"]');
  await page.waitForSelector('[data-act="newTalk"]');
  ok(page.url().endsWith("#/talk"), "Talk button on Progress opens #/talk");
  ok((await page.locator("#tabs a.on").getAttribute("data-tab")) === "me", "tab highlight stays on Progress");
  const t0 = await text();
  ok(t0.includes("What goes to Claude") && t0.includes("the whole conversation so far") && t0.includes("your About text and your talk notes") && t0.includes("no food photos") && !t0.includes("age, training"), "privacy card says what is sent");
  ok(t0.includes("stay on this phone only") && t0.includes('"Download everything"') && t0.includes("talk/notes.md"), "privacy card says where things live");
  ok((await page.locator("#talkAbout").count()) === 1 && /about you/i.test(t0) && t0.includes("Private, stays on this phone."), "About you card present and marked private");   // the h2 is CSS-uppercased
  ok(t0.includes("Write notes after talks") && t0.includes("Clear notes on this phone"), "notes toggle and clear button present");
  ok(t0.includes("No notes yet"), "notes section shows the empty state");
  ok(t0.includes("API key") && (await page.locator('[data-act="newTalk"]').isDisabled()), "no key: New talk disabled with a Settings link");
  await page.goto(URL0 + "#/talk/new");
  await page.waitForSelector(".composer");
  ok((await page.locator("#talkIn").count()) === 0 && (await page.locator('.composer a[href="#/settings"]').count()) === 1, "no key: chat shows the Settings card instead of a composer");
  ok((await text()).includes("In crisis? Call or text 988."), "crisis line in the chat footer");

  // key + backup token
  await page.goto(URL0 + "#/settings");
  await page.fill('input[data-set="apiKey"]', "sk-ant-test");
  await blur('input[data-set="apiKey"]');
  await page.fill('input[data-set="token"]', "github_pat_test");
  await blur('input[data-set="token"]');
  await page.waitForFunction(() => /Backed up|failed/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  ok((await page.locator("#syncStatus").innerText()).startsWith("Backed up"), "backup on", await page.locator("#syncStatus").innerText());

  // About you: saved on blur, survives a reload
  await page.goto(URL0 + "#/talk");
  await page.waitForSelector('[data-act="newTalk"]:not([disabled])');
  const about1 = "Working on a side project after work and training four days a week.";
  await page.fill("#talkAbout", about1);
  await blur("#talkAbout");
  await page.reload();
  await page.waitForSelector("#talkAbout");
  ok((await page.inputValue("#talkAbout")) === about1, "About you saved on blur and survives reload");

  // first talk: streams a reply into a bubble
  await page.click('[data-act="newTalk"]');
  await page.waitForSelector("#talkIn");
  ok(page.url().endsWith("#/talk/new"), "New talk opens an empty chat");
  ok((await text()).includes("What's on your mind?"), "empty chat prompt");
  await send("work has been a lot this week");
  await page.waitForSelector(".typing", { timeout: 30000 });
  ok(await page.locator('[data-act="send"]').isDisabled(), "Send disabled while streaming");
  ok((await page.locator(".msg.u").count()) === 1 && (await page.locator(".msg.u").innerText()).includes("a lot this week"), "his message in a bubble right away");
  ok((await page.inputValue("#talkIn")) === "", "composer cleared on send");
  await page.waitForSelector('.msg.a:has-text("weighing on you most right now?")', { timeout: 30000 });
  await sendEnabled();
  ok(true, "reply streamed into a bubble and Send re-enabled");
  ok(/#\/talk\/[a-z0-9]+$/.test(page.url()) && !page.url().endsWith("/new"), "url replaced with the talk id");
  const talk1 = page.url().split("/").pop();
  const c1 = calls[0];
  ok(c1.body.model === "claude-opus-5-5" && c1.body.stream === true && c1.body.max_tokens === 16000, "request: opus 5.5, stream true, max_tokens 16000", c1.body.model);
  ok(c1.body.fallbacks === "default" && /server-side-fallback-2026-07-01/.test(c1.headers["anthropic-beta"] || ""), "fallbacks default + beta header");
  ok(c1.body.cache_control && c1.body.cache_control.type === "ephemeral", "cache_control ephemeral on the request");
  ok(c1.body.output_config && c1.body.output_config.effort === "medium" && !c1.body.output_config.format, "effort medium, plain text");
  ok(typeof c1.body.system === "string" && c1.body.system.startsWith("You are Perry's friend who is also a mentor.") && c1.body.system.includes('What you know about him comes from the "About him" and "notes from past talks" sections below'), "generic TALK_SYSTEM sent as system");
  ok(c1.body.system.includes("\n\nAbout him (written by him):\n\n" + about1 + "\n\nNo notes from past talks yet."), "About text is in the system of a new talk, before the notes block");
  ok(c1.body.system.includes("988 Suicide & Crisis Lifeline") && c1.body.system.includes("if it's an emergency right now, 911."), "safety paragraph incl. 988 and the 911 line");
  ok(c1.body.system.endsWith("\n\nNo notes from past talks yet."), "system says there are no notes yet");
  ok(c1.body.messages.length === 1 && c1.body.messages[0].role === "user" && c1.body.messages[0].content === "work has been a lot this week", "first message only, plain string content");
  ok((await text()).includes("≈ 4¢ so far"), "cost shows (5000 in, 400 out, 2000 cache write)", await text());
  ok((await page.locator('[data-act="wrapUp"]').count()) === 1, "Wrap up appears after a reply");

  // the PC writes notes.md with an extra section; opening #/talk pulls it; he edits About; the running talk keeps its frozen system prompt
  const pcNotes = "# Talk notes (private, Perry's)\n\n## Patterns I've noticed\n- 2026-10-20: Sleeps better on days he walks.\n## Things I've learned about myself\n## What helps\n## Threads to come back to\n- 2026-10-20: The move next spring.\n\n## Wave playbook\n1. Clear the wave before the fight\n2. Then rotate\n";
  repo.set("talk/notes.md", { content: b64(pcNotes), sha: "pc1" });
  await page.goto(URL0 + "#/talk");
  await page.waitForSelector('.notes:has-text("Sleeps better")', { timeout: 10000 });
  ok((await text()).includes("Wave playbook") && (await text()).includes("talk/notes.md"), "remote notes.md pulled into the list, extra section shown");
  ok((await text()).includes("work has been a lot this week"), "conversation listed by its first words", await text());
  const about2 = about1 + " Also learning to cook.";
  await page.fill("#talkAbout", about2);
  await blur("#talkAbout");
  await page.click(`a[href="#/talk/${talk1}"]`);
  await page.waitForSelector("#talkIn");
  reply = "Last time you mentioned the move. Same feeling, or something different this time?";
  await send("Maybe. It's quieter.", '.msg.a:has-text("something different this time?")');
  await sendEnabled();
  const c2 = calls[1];
  ok(c2.body.system === c1.body.system, "system byte-identical between message 1 and 2 even though notes and About changed in between");
  ok(c2.body.messages.length === 3 && c2.body.messages[1].role === "assistant" && c2.body.messages[1].content.includes("weighing on you most") && c2.body.messages[2].content === "Maybe. It's quieter.", "full prior conversation on message 2");
  ok((await text()).includes("≈ 8¢ so far"), "cost accumulates", await text());
  await page.screenshot({ path: path.join(__dirname, "talk-chat.png"), fullPage: true });

  // survives reload
  await page.reload();
  await page.waitForSelector(".msg.a");
  ok((await page.locator(".msg").count()) === 4 && (await text()).includes("≈ 8¢ so far"), "conversation and cost survive reload");

  // leaving a talk with two replies offers the notes once
  await page.goto(URL0 + "#/talk");
  await page.waitForSelector('[data-act="newTalk"]');
  ok((await toastText()).includes("Save notes from this talk?") && (await page.locator("#toastBtn").isVisible()), "leaving offers to save notes", await toastText());

  // a new talk gets the edited About and the pulled notes in its system prompt
  await page.click('[data-act="newTalk"]');
  await page.waitForSelector("#talkIn");
  reply = "That's fair. What would make next week feel lighter?";
  await send("I want next week to be calmer", '.msg.a:has-text("feel lighter?")');
  await sendEnabled();
  const c3 = calls[2];
  const want3 = c1.body.system.replace("About him (written by him):\n\n" + about1, "About him (written by him):\n\n" + about2)
    .replace("\n\nNo notes from past talks yet.", "\n\nYour notes from past talks with him (from his PC and his phone):\n\n" + pcNotes);
  ok(c3.body.system === want3, "next talk's system carries the edited About and the remote notes verbatim");
  ok(c3.body.messages.length === 1, "new talk starts a fresh conversation");

  // wrap up: one structured call, raw markdown to the repo and the phone
  await page.click('[data-act="wrapUp"]');
  await page.waitForFunction(() => document.getElementById("toastText").textContent.includes("Talk notes:"), null, { timeout: 30000 });
  const nc = notesCalls()[0];
  ok(nc && nc.body.stream !== true && nc.body.model === "claude-opus-5-5" && nc.body.max_tokens === 16000, "notes call is non-streaming, max_tokens 16000", nc && nc.body.max_tokens);
  ok(nc.body.output_config.effort === "low" && nc.body.output_config.format.type === "json_schema" && nc.body.output_config.format.schema.required.join() === "notes,summary", "notes call: low effort, json schema");
  ok(nc.body.fallbacks === "default" && /server-side-fallback-2026-07-01/.test(nc.headers["anthropic-beta"] || ""), "notes call keeps fallbacks");
  ok(nc.body.system.startsWith("You keep Perry's private talk notes") && nc.body.system.includes("every existing section and its order exactly as they are") && nc.body.system.includes("Don't record counts or statistics from the Moments summary in the notes."), "NOTES_SYSTEM keeps every existing section and keeps Moments counts out");
  const np = nc.body.messages[0].content;
  ok(/^Today's date: \d{4}-\d{2}-\d{2}\n\nCurrent notes:\n/.test(np) && np.includes("Current notes:\n" + pcNotes) && np.includes("## Wave playbook"), "notes prompt carries the current file incl. the extra section");
  ok(np.includes("\n\nConversation:\nPerry: I want next week to be calmer\nYou: That's fair."), "notes prompt carries the conversation as Perry:/You: lines");
  ok(!np.includes(about2), "About text is not in the notes prompt");
  const saved = notesFile();
  ok(saved.startsWith("# Talk notes (private, Perry's)") && saved.includes("- 2026-10-24: Likes long walks after work.") && saved.includes("## Wave playbook\n1. Clear the wave"), "talk/notes.md written as raw markdown, extra section intact");
  ok(!saved.trim().startsWith("{") && !saved.includes("I want next week to be calmer"), "not JSON, no transcript");
  ok((await toastText()).includes("Added a line about walks after work."), "toast shows the summary");
  ok((await page.locator('[data-act="wrapUp"]').count()) === 0, "Wrap up hidden once the notes cover the talk");
  ok((await text()).includes("≈ 6¢ so far"), "notes call cost counted into the talk (4¢ + 2¢)", await text());
  await page.goto(URL0 + "#/talk");
  await page.waitForSelector(".notes");
  ok((await text()).includes("Likes long walks after work"), "local notes copy updated");
  await page.screenshot({ path: path.join(__dirname, "talk.png"), fullPage: true });

  // the next talk's system includes those notes
  await page.click('[data-act="newTalk"]');
  await page.waitForSelector("#talkIn");
  reply = "Okay. What's one thing you'd drop?";
  await send("Fewer late nights", '.msg.a:has-text("one thing you\'d drop?")');
  await sendEnabled();
  ok(calls[calls.length - 1].body.system.includes("- 2026-10-24: Likes long walks after work."), "notes written by wrap-up reach the next talk's system");

  // 409 on PUT: re-fetch and redo the merge once
  const pcEdit = saved.replace("## What helps\n", "## What helps\n- 2026-10-24: a walk before replying (from the PC)\n");
  notesPutFail = () => repo.set("talk/notes.md", { content: b64(pcEdit), sha: "pc2" });
  notesOut = (cur) => ({ notes: cur.replace("## Threads to come back to\n", "## Threads to come back to\n- 2026-10-24: What a calmer week would look like.\n"), summary: "Added a thread about a calmer week." });
  const nBefore = notesCalls().length;
  await page.click('[data-act="wrapUp"]');
  await page.waitForFunction(() => document.getElementById("toastText").textContent.includes("a calmer week"), null, { timeout: 30000 });
  ok(notesCalls().length === nBefore + 2, "409 made the app re-fetch and redo the merge once", notesCalls().length - nBefore);
  ok(notesCalls()[notesCalls().length - 1].body.messages[0].content.includes("a walk before replying (from the PC)"), "second merge ran on the re-fetched file");
  const saved2 = notesFile();
  ok(saved2.includes("a walk before replying") && saved2.includes("What a calmer week would look like") && repo.get("talk/notes.md").sha !== "pc2", "retry wrote on top of the PC's edit");
  ok(notesPutFail === null, "the 409 hook fired");
  notesOut = null;

  // refusal: partial text dropped, gentle line shown, his turn marked and left out from then on
  nextStop = "refusal";
  reply = "partial text that should vanish";
  await send("skip this one", ".note:has-text(\"I couldn't answer that one\")");
  await sendEnabled();
  const tr = await text();
  ok(!tr.includes("partial text that should vanish") && tr.includes("If you're not safe right now, call or text 988."), "refusal drops the partial reply and shows the 988 line");
  ok(tr.includes("skip this one") && tr.includes("(declined"), "the refused turn stays visible, marked");
  // max_tokens: keep the text, mark it
  nextStop = "max_tokens";
  reply = "This got long and";
  await send("go on", '.msg.a:has-text("This got long and")');
  await sendEnabled();
  ok((await text()).includes("(cut off)"), "a cut-off reply is kept and marked");
  const lastMsgs = calls[calls.length - 1].body.messages;
  ok(lastMsgs.filter((m) => m.role === "assistant").every((m) => !m.content.includes("couldn't answer")), "the refusal line is never sent back to Claude");
  ok(lastMsgs.every((m) => m.content !== "skip this one") && lastMsgs.some((m) => m.content === "Fewer late nights"), "the refused turn is left out of later requests; the rest of the conversation stays");

  // double tap on Send: one message, one call; the composer keeps focus and what he typed meanwhile
  reply = "One at a time is fine.";
  const nCalls = calls.length;
  await page.fill("#talkIn", "sent twice by accident");
  await page.evaluate(() => { const b = document.querySelector('[data-act="send"]'); b.click(); b.click(); });
  await page.waitForSelector(".typing", { timeout: 30000 });
  await page.focus("#talkIn");
  await page.type("#talkIn", "next thought");
  await page.waitForSelector('.msg.a:has-text("One at a time is fine.")', { timeout: 30000 });
  await sendEnabled();
  ok((await page.locator('.msg.u:has-text("sent twice by accident")').count()) === 1 && calls.length === nCalls + 1, "a double tap on Send sends once", calls.length - nCalls);
  ok(await page.evaluate(() => { const a = document.activeElement; return !!a && a.id === "talkIn" && a.value === "next thought" && a.selectionStart === a.value.length; }), "composer keeps focus, its text and the caret at the end when the reply lands");

  // API error: inline, his message kept, Retry works
  failWith = 529;
  await send("are you there", '[data-act="retry"]');
  const te = await text();
  ok(te.includes("Claude had a problem (529)") && (await page.locator('.msg.u:has-text("are you there")').count()) === 1, "error shown inline with his message kept", te);
  ok(!(await page.locator('[data-act="send"]').isDisabled()), "Send usable again after an error");
  failWith = 0;
  reply = "Still here.";
  await page.click('[data-act="retry"]');
  await page.waitForSelector('.msg.a:has-text("Still here.")', { timeout: 30000 });
  await sendEnabled();
  const lm = calls[calls.length - 1].body.messages;
  ok(lm[lm.length - 1].role === "user" && lm[lm.length - 1].content === "are you there" && (await page.locator('[data-act="retry"]').count()) === 0, "Retry resends the same conversation and clears the error");

  // wrap-up reply cut off: nothing written, clear message, Wrap up still there
  notesStop = "max_tokens";
  await page.click('[data-act="wrapUp"]');
  await page.waitForFunction(() => document.getElementById("toastText").textContent.includes("cut off"), null, { timeout: 30000 });
  await page.waitForSelector('[data-act="wrapUp"]');
  ok(notesFile() === saved2, "a cut-off notes reply changes nothing and leaves Wrap up available");

  // app closed mid-reply: his message is saved, no reply ever lands; reopening offers Retry
  hang = true;
  await page.fill("#talkIn", "did that go through");
  await page.click('[data-act="send"]');
  await page.waitForSelector(".typing", { timeout: 30000 });
  await page.reload();
  await page.waitForSelector('[data-act="retry"]', { timeout: 10000 });
  const ts = await text();
  ok(ts.includes("did that go through") && ts.includes("No reply came back.") && !(await page.locator('[data-act="send"]').isDisabled()), "after a reload mid-reply, his message is kept and Retry offered", ts);
  reply = "It did.";
  await page.click('[data-act="retry"]');
  await page.waitForSelector('.msg.a:has-text("It did.")', { timeout: 30000 });
  await sendEnabled();
  ok((await page.locator('[data-act="retry"]').count()) === 0, "Retry after a reload gets the reply");

  // conversations and the About text never leave the phone
  const repoText = [...repo.values()].map((v) => unb64(v.content)).join("\n");
  ok(![...repo.keys()].some((k) => /talks|about/i.test(k)) && !repoText.includes("a lot this week") && !repoText.includes("are you there") && !repoText.includes("side project"), "conversations and About are not written to the repo", [...repo.keys()]);
  await page.goto(URL0 + "#/settings");
  await page.waitForSelector('[data-act="export"]');
  await page.evaluate(() => {
    window.__blob = null;
    URL.createObjectURL = (b) => { window.__blob = b; return "blob:fake"; };
    HTMLAnchorElement.prototype.click = function () {};
    Object.defineProperty(navigator, "canShare", { value: undefined, configurable: true });
  });
  await page.click('[data-act="export"]');
  await page.waitForFunction(() => !!window.__blob);
  const exp = await page.evaluate(() => window.__blob.text());
  ok(!exp.includes("a lot this week") && !("talks" in JSON.parse(exp)) && !("talkNotes" in JSON.parse(exp)), "export leaves conversations out");
  ok(!exp.includes("side project") && !("talkAbout" in JSON.parse(exp)), "export leaves the About text out");
  ok((await text()).includes("Claude calls, about $"), "settings counts Claude calls honestly", await text());

  // toggle off hides Wrap up
  await page.goto(URL0 + "#/talk");
  await page.waitForSelector('input[data-set="writeNotes"]');
  await page.uncheck('input[data-set="writeNotes"]');
  await page.click(`a[href="#/talk/${talk1}"]`);
  await page.waitForSelector("#talkIn");
  ok((await page.locator('[data-act="wrapUp"]').count()) === 0, "notes toggle off hides Wrap up on a talk with unsaved replies");
  await page.goto(URL0 + "#/talk");
  await page.waitForSelector('input[data-set="writeNotes"]');
  await page.check('input[data-set="writeNotes"]');
  await page.click(`a[href="#/talk/${talk1}"]`);
  await page.waitForSelector('[data-act="wrapUp"]');
  ok(true, "toggle back on brings Wrap up back");

  // delete one (two taps), then all (two taps); real deletes
  await page.click('[data-act="deleteTalk"]');
  ok((await page.locator('[data-act="deleteTalk"]').innerText()).includes("Tap again") && (await page.locator(".msg").count()) === 4, "first delete tap only arms");
  await page.click('[data-act="deleteTalk"]');
  await page.waitForSelector('[data-act="newTalk"]');
  ok(!(await text()).includes("a lot this week") && (await page.locator(".wrow").count()) === 2, "conversation deleted; the other two remain");
  await page.click('[data-act="deleteTalks"]');
  ok((await page.locator('[data-act="deleteTalks"]').innerText()).includes("Tap again") && (await page.locator(".wrow").count()) === 2, "first delete-all tap only arms");
  await page.click('[data-act="deleteTalks"]');
  await page.waitForSelector(".card:has-text(\"No talks yet\")");
  await page.reload();
  await page.waitForSelector('[data-act="newTalk"]');
  ok((await text()).includes("No talks yet") && (await page.locator('[data-act="deleteTalks"]').count()) === 0, "all conversations gone, also after reload");
  ok((await text()).includes("What a calmer week would look like"), "deleting talks leaves the notes alone");
  ok((await page.inputValue("#talkAbout")) === about2, "deleting talks leaves About alone");

  // clear notes on this phone: two taps, local only
  await page.click('[data-act="clearNotes"]');
  ok((await page.locator('[data-act="clearNotes"]').innerText()).includes("Tap again"), "first clear tap only arms");
  await page.click('[data-act="clearNotes"]');
  await page.waitForFunction(() => document.getElementById("toastText").textContent.includes("Notes cleared"));
  ok(notesFile() === saved2, "repo copy untouched by clearing the phone");

  // notes written while backup is off are not thrown away when it comes back: both copies are kept, and the next wrap-up writes the union
  await page.goto(URL0 + "#/settings");
  await page.fill('input[data-set="token"]', "");
  await blur('input[data-set="token"]');
  await page.goto(URL0 + "#/talk");
  await page.waitForSelector('[data-act="newTalk"]:not([disabled])');
  await page.click('[data-act="newTalk"]');
  await page.waitForSelector("#talkIn");
  reply = "Noted. Anything else on the list?";
  await send("Started the garden this weekend", '.msg.a:has-text("Anything else on the list?")');
  await sendEnabled();
  const talkOff = page.url().split("/").pop();
  notesOut = (cur) => ({ notes: cur.replace("## What helps\n", "## What helps\n- 2026-10-24: Writing the list down the night before.\n"), summary: "Added a line about the list." });
  await page.click('[data-act="wrapUp"]');
  await page.waitForFunction(() => document.getElementById("toastText").textContent.includes("about the list"), null, { timeout: 30000 });
  ok(notesFile() === saved2, "offline wrap-up writes nothing to the repo");
  await page.goto(URL0 + "#/settings");
  await page.fill('input[data-set="token"]', "github_pat_test");
  await blur('input[data-set="token"]');
  await page.waitForFunction(() => /Backed up|failed/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  await page.goto(URL0 + "#/talk");
  await page.waitForSelector('.notes:has-text("a walk before replying")', { timeout: 10000 });
  const shown = await page.locator(".notes").innerText();
  ok(shown.includes("- 2026-10-24: a walk before replying (from the PC)\n- 2026-10-24: Writing the list down the night before.") && shown.includes("## Wave playbook") && shown.includes("What a calmer week would look like"), "backup back on: the repo's notes plus the phone's offline line, under its own section", shown);
  ok(notesFile() === saved2, "the union isn't pushed until the next wrap-up");
  await page.click(`a[href="#/talk/${talkOff}"]`);
  await page.waitForSelector("#talkIn");
  reply = "Good. Keep it short.";
  await send("Just the garden and the list", '.msg.a:has-text("Keep it short.")');
  await sendEnabled();
  notesOut = (cur) => ({ notes: cur, summary: "Nothing new to add." });
  await page.click('[data-act="wrapUp"]');
  await page.waitForFunction(() => document.getElementById("toastText").textContent.includes("Nothing new to add."), null, { timeout: 30000 });
  const saved3 = notesFile(), lastNp = notesCalls()[notesCalls().length - 1].body.messages[0].content;
  ok(lastNp.includes("Writing the list down") && lastNp.includes("a walk before replying"), "the wrap-up ran on the union");
  ok(saved3.startsWith("# Talk notes (private, Perry's)\n\n## Patterns") && saved3.includes("a walk before replying (from the PC)\n- 2026-10-24: Writing the list down the night before.\n") && saved3.includes("## Wave playbook\n1. Clear the wave") && (saved3.match(/Writing the list down/g) || []).length === 1, "the next wrap-up writes the union back, once, sections intact", saved3);
  notesOut = null;

  ok(errors.filter((e) => !/status of (404|409|529)|ERR_ABORTED|net::ERR_FAILED/.test(e)).length === 0, "no page errors (404/409/529 are the fakes answering)", errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
