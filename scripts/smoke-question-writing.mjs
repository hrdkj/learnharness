/** Isolated browser regressions for repeated capture, pen contact, footer layout, and PNG export.
 * Run after npm run build, or set LH_SMOKE_DEV=1 for an unused dev checkout.
 * LH_SMOKE_APP_DIR can select a separate checkout when a dev server is active. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import puppeteer from "puppeteer-core";

const root = process.env.LH_SMOKE_APP_DIR || path.resolve(import.meta.dirname, "..");
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "lh-writing-smoke-"));
const output = process.env.LH_SMOKE_OUTPUT || path.join(profile, "artifacts");
await fs.mkdir(output, { recursive: true });
await fs.mkdir(path.join(profile, "data/chats"), { recursive: true });
await fs.writeFile(path.join(profile, "auth.json"), "{}", { mode: 0o600 });
const chat = {
	version: 1, id: "writing_smoke", title: "Writing verification", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
	messages: [{
		id: "fixture-question", role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-5",
		content: [{ type: "toolCall", id: "fixture-call", name: "probe", arguments: {
			question: "Choose the correct answer.\n\n" + Array.from({ length: 16 }, (_, i) => `Paragraph ${i + 1}: Consider the expression and identify which answer satisfies it.`).join("\n\n"),
			options: ["First", "Second", "Third", "Last"].map(label => ({ label: `${label} answer`, value: label.toLowerCase() })),
			explanation: "Fixture explanation.", correctAnswer: "first",
		} }], stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	}],
};
await fs.writeFile(path.join(profile, "data/chats/writing_smoke.json"), JSON.stringify(chat));
const reopenChat = structuredClone(chat);
reopenChat.id = "writing_reopen";
reopenChat.title = "Repeated writing capture";
reopenChat.messages[0].content[0].arguments.question = String.raw`Using the same table:

| | Positive test | Negative test |
|---|---|---|
| Condition present | **30** | **10** |
| Condition absent | **20** | **140** |

We discard everyone with a negative test, then select one person from whoever remains.

The conditional probability is $P(A\mid B)=\frac{30}{30+20}$.

Which people are eligible to be selected? No probability calculation is needed.`;
await fs.writeFile(path.join(profile, "data/chats/writing_reopen.json"), JSON.stringify(reopenChat));
const practiceChat = structuredClone(reopenChat);
practiceChat.id = "practice_writing";
practiceChat.kind = "practice";
practiceChat.title = "Practice handwriting verification";
practiceChat.messages[0].content = [{ type: "toolCall", id: "practice-problem-1", name: "problem", arguments: {
	statement: reopenChat.messages[0].content[0].arguments.question,
	mode: "recall", target: [], modelSolution: "PRIVATE MODEL SOLUTION MUST NOT BE CAPTURED",
} }];
const practiceAck = (id) => ({ id: `ack-${id}`, role: "toolResult", toolCallId: id, toolName: "problem",
	content: [{ type: "text", text: "Problem posed." }], details: null, isError: false, timestamp: Date.now() });
practiceChat.messages.push(practiceAck("practice-problem-1"));
const practiceFile = path.join(profile, "data/chats/practice_writing.json");
await fs.writeFile(practiceFile, JSON.stringify(practiceChat));
const socket = createServer();
await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", process.env.LH_SMOKE_DEV ? "dev" : "start", "-H", "127.0.0.1", "-p", String(port)], {
	cwd: root, env: { ...process.env, LH_DATA_DIR: path.join(profile, "data"), LH_AUTH_FILE: path.join(profile, "auth.json") },
	stdio: ["ignore", "pipe", "pipe"],
});
let logs = "", browser, page, submission;
child.stdout.on("data", data => { logs += data; });
child.stderr.on("data", data => { logs += data; });
const errors = [];
const canvasSelector = '[data-testid="question-writing-canvas"]';
const footerSelector = '[data-testid="question-writing-thinking"]';
const practiceAttempts = [], practiceSubmissions = [];
let refusePractice = true;
try {
	for (let attempt = 0; ; attempt++) {
		try { if ((await fetch(origin)).ok) break; } catch {}
		assert(attempt < 180 && child.exitCode === null, "Smoke server did not start: " + logs.slice(-6000));
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
	page = await browser.newPage();
	await page.setViewport({ width: 1360, height: 1000, deviceScaleFactor: 1 });
	page.on("pageerror", error => errors.push(error.message));
	// Inspect the actual SVG handed to Image, before it becomes a PNG.
	await page.evaluateOnNewDocument(() => {
		window.writingCaptures = [];
		const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
		Object.defineProperty(HTMLImageElement.prototype, "src", { ...descriptor, set(value) {
			if (value.startsWith("data:image/svg+xml")) {
				const svg = decodeURIComponent(value.slice(value.indexOf(",") + 1));
				const fonts = [...svg.matchAll(/@font-face\s*\{[^}]*\}/g)].map(match => match[0]);
				window.writingCaptures.push({ fontCount: fonts.length, allFontsEmbedded: fonts.every(font => /src:\s*url\(["']?data:/.test(font)), hasMath: svg.includes("katex") });
			}
			descriptor.set.call(this, value);
		} });
	});
	await page.setRequestInterception(true);
	page.on("request", async request => {
		if (request.url() === origin + "/api/chat") {
			submission = JSON.parse(request.postData());
			if (submission.chatId === practiceChat.id) {
				practiceAttempts.push(submission.input);
				if (refusePractice) {
					await request.respond({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Writing smoke rejected this send." }) });
					return;
				}
				const input = submission.input;
				practiceSubmissions.push(input);
				practiceChat.messages.push({ id: `thinking-${practiceSubmissions.length}`, role: "custom", customType: "practice-thinking",
					content: `Your thinking:\n${input.text}`, details: { problemCallId: input.problemCallId, text: input.text, workingImage: input.workingImage },
					display: true, timestamp: Date.now() });
				const assistant = { ...structuredClone(chat.messages[0]), id: `feedback-${practiceSubmissions.length}`, stopReason: "stop", content: [{ type: "text", text: "Continue working on the same problem." }] };
				practiceChat.messages.push(assistant);
				if (practiceSubmissions.length === 2) {
					practiceChat.messages.push(
						{ ...structuredClone(assistant), id: "conclude-problem", stopReason: "toolUse", content: [{ type: "toolCall", id: "practice-conclude", name: "conclude", arguments: { outcome: "solved" } }] },
						{ id: "conclude-ack", role: "toolResult", toolName: "conclude", toolCallId: "practice-conclude", content: [{ type: "text", text: "Concluded." }], isError: false, timestamp: Date.now() },
						{ ...structuredClone(practiceChat.messages[0]), id: "next-problem", content: [{ type: "toolCall", id: "practice-problem-2", name: "problem", arguments: { statement: "A fresh practice problem.", mode: "recall", target: [], modelSolution: "Private." } }] },
						practiceAck("practice-problem-2"),
					);
				}
				await fs.writeFile(practiceFile, JSON.stringify(practiceChat));
				await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
				return;
			}
			void request.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Writing smoke captured the answer." }) });
		} else if (request.url() === origin + `/api/chats/${practiceChat.id}/stream`) {
			await request.respond({ status: 200, contentType: "text/event-stream", body: 'data: {"type":"turn-settled"}\n\n' });
		} else if (request.url().startsWith(origin) || /^(data|blob):/.test(request.url())) void request.continue();
		else void request.abort();
	});
	await page.goto(origin + "/chat/writing_reopen", { waitUntil: "networkidle2", timeout: 120000 });
	await page.waitForSelector('[data-testid="question-write"]');
	const openWriting = async () => {
		await page.click('[data-testid="question-write"]');
		await page.waitForSelector(canvasSelector);
		await page.waitForFunction(() => !document.querySelector('[data-testid="question-writing-overlay"] [role="status"]'));
	};
	const closeWriting = async () => {
		await page.click('[data-testid="question-writing-interact"]');
		await page.waitForSelector('[data-testid="question-writing-overlay"]', { hidden: true });
	};
	const background = () => page.$eval('[data-testid="question-writing-overlay"] img', async image => {
		await image.decode();
		return image.src;
	});
	let firstBackground;
	for (let attempt = 1; attempt <= 3; attempt++) {
		await openWriting();
		const image = await background();
		await fs.writeFile(path.join(output, `reopen-background-${attempt}.png`), Buffer.from(image.split(",")[1], "base64"));
		await page.screenshot({ path: path.join(output, `reopen-${attempt}.png`) });
		const capture = await page.evaluate(() => window.writingCaptures.at(-1));
		assert(capture?.fontCount > 0 && capture.allFontsEmbedded, `Capture ${attempt} must embed every font source`);
		assert(capture.hasMath, "The repeated-capture fixture must include rendered math");
		if (attempt === 1) firstBackground = image;
		else assert(image === firstBackground, `Capture ${attempt} must preserve table, math, and answer pixels`);
		assert(await page.$(footerSelector), "The thinking box must remain available while writing");
		await closeWriting();
	}
	const repeatedCaptures = await page.evaluate(() => window.writingCaptures);
	assert.equal(repeatedCaptures.length, 3, "Each empty reopening must exercise a fresh capture");
	console.log("Three empty Write → Interact → Write captures preserve fonts and identical pixels, including tables and math.");
	await page.goto(origin + "/chat/writing_smoke", { waitUntil: "networkidle2", timeout: 120000 });
	await page.waitForSelector('[data-testid="question-write"]');
	await page.click('[data-testid="question-dock"] [data-kbdrow="0"]');
	await page.click('[data-testid="question-write"]');
	await page.waitForSelector(canvasSelector);
	await page.waitForFunction(() => !document.querySelector('[data-testid="question-writing-overlay"] [role="status"]'));
	const layout = await page.evaluate(() => {
		const canvas = document.querySelector('[data-testid="question-writing-canvas"]');
		const footer = document.querySelector('[data-testid="question-writing-thinking"]');
		return { canvasBottom: canvas.getBoundingClientRect().bottom, footerTop: footer.getBoundingClientRect().top, height: canvas.height, displayedHeight: canvas.clientHeight };
	});
	assert(layout.canvasBottom <= layout.footerTop, "The full drawing sheet must remain above the footer");
	assert(Math.abs(layout.height - layout.displayedHeight) <= 1, "Initial capture must use the final sheet height after the live field is portaled");
	await page.screenshot({ path: path.join(output, "tall-question.png") });
	console.log("Tall question fits above the live footer.");
	// Trusted pen events exercise real pointer capture and actual canvas pixels.
	const client = await page.createCDPSession();
	const box = await (await page.$(canvasSelector)).boundingBox();
	const x = box.x + box.width - 70, y = box.y + box.height / 2;
	const pen = (type, px, py, buttons, force, button = "none") => client.send("Input.dispatchMouseEvent", { type, x: px, y: py, buttons, force, button, pointerType: "pen" });
	const pixels = () => page.$eval(canvasSelector, canvas => canvas.toDataURL());
	await pen("mousePressed", x, y, 1, 0.5, "left");
	await pen("mouseMoved", x + 20, y, 1, 0.5);
	await pen("mouseReleased", x + 20, y, 0, 0, "left");
	const ink = await pixels();
	assert(await page.$eval(canvasSelector, canvas => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 === 3 && value > 0)), "The fixture must contain ink");
	// CDP has no eraser button enum. Inject button 5 with a capture stub;
	// the actual component handlers and real canvas rendering still run.
	const eraser = samples => page.$eval(canvasSelector, async (canvas, samples) => {
		const captures = new Set();
		const methods = ["setPointerCapture", "hasPointerCapture", "releasePointerCapture"];
		const descriptors = methods.map(name => Object.getOwnPropertyDescriptor(canvas, name));
		canvas.setPointerCapture = id => { captures.add(id); };
		canvas.hasPointerCapture = id => captures.has(id);
		canvas.releasePointerCapture = id => { captures.delete(id); };
		try {
			for (const [type, clientX, clientY, buttons, pressure, button] of samples) {
				canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 100, pointerType: "pen", clientX, clientY, buttons, pressure, button }));
			}
			await new Promise(requestAnimationFrame);
		} finally {
			methods.forEach((name, i) => { if (descriptors[i]) Object.defineProperty(canvas, name, descriptors[i]); else delete canvas[name]; });
		}
	}, samples);
	await eraser([
		["pointerdown", x, y + 50, 32, 0, 5], ["pointermove", x, y, 32, 0, -1], ["pointerup", x, y, 0, 0, 5],
	]);
	assert(await pixels() === ink, "Hovering with an eraser button must preserve ink");
	await eraser([
		["pointerdown", x, y + 50, 32, 0, 5], ["pointermove", x, y, 33, 0.5, 0],
		["pointermove", x, y + 50, 32, 0, 0], ["pointerup", x, y + 50, 0, 0, 5],
	]);
	assert(await pixels() !== ink, "Touching down with the eraser already held must erase ink");
	await page.$$eval('[aria-label="Writing tools"] button', buttons => buttons.find(button => button.textContent.trim() === "Undo").click());
	assert(await pixels() === ink, "Undo restores the complete erased stroke");
	console.log("Pen hover, eraser contact, and Undo preserve the expected canvas pixels.");
	const inkBackground = await background();
	await closeWriting();
	await openWriting();
	assert(await background() === inkBackground, "Reopening existing ink must preserve its frozen question");
	assert(await pixels() === ink, "Reopening existing ink must preserve every stroke pixel");
	assert.equal(await page.evaluate(() => window.writingCaptures.length), 1, "Existing ink must reuse its background instead of recapturing");
	// A growing live field must shrink the sheet rather than cover its content.
	const field = footerSelector + ' [contenteditable="true"], ' + footerSelector + " textarea";
	await page.click(field);
	await page.type(field, Array.from({ length: 7 }, (_, i) => `Reasoning line ${i + 1}.`).join("\n"));
	assert(await page.evaluate(() => document.querySelector('[data-testid="question-writing-canvas"]').getBoundingClientRect().bottom <= document.querySelector('[data-testid="question-writing-thinking"]').getBoundingClientRect().top));
	const expectedImage = await page.evaluate(async () => {
		const ink = document.querySelector('[data-testid="question-writing-canvas"]');
		const background = ink.previousElementSibling;
		await background.decode();
		const combined = document.createElement("canvas");
		combined.width = ink.width; combined.height = ink.height;
		combined.getContext("2d").drawImage(background, 0, 0, ink.width, ink.height);
		combined.getContext("2d").drawImage(ink, 0, 0);
		return combined.toDataURL().split(",")[1];
	});
	await page.click('[data-testid="question-writing-interact"]');
	await page.waitForSelector('[data-testid="question-writing-overlay"]', { hidden: true });
	await page.click('[data-testid="question-dock"] button[type="submit"]');
	await page.waitForFunction(() => document.body.textContent.includes("Writing smoke captured the answer."));
	assert(submission.input.answer.workingImage.data === expectedImage, "PNG export must contain exactly the frozen question and ink");
	assert.match(submission.input.answer.thinking, /Reasoning line 7/);

	// Exercise the practice dock in the real renderer with deterministic tutor
	// responses. The practice-flow tests cover the real server/model boundary.
	await page.goto(origin + "/chat/practice_writing", { waitUntil: "networkidle2", timeout: 120000 });
	await page.waitForSelector('[data-testid="practice-dock"]');
	await openWriting();
	assert(await page.$(footerSelector + ' [data-testid="practice-thinking-field"]'), "Practice must keep the live thinking box in Write");
	assert.equal(await page.$eval('[data-question-writing-content]', node => node.textContent.includes("PRIVATE MODEL SOLUTION")), false);
	const practiceBox = await (await page.$(canvasSelector)).boundingBox();
	const practiceX = practiceBox.x + practiceBox.width - 90, practiceY = practiceBox.y + practiceBox.height / 2;
	await pen("mousePressed", practiceX, practiceY, 1, 0.5, "left");
	await pen("mouseMoved", practiceX + 30, practiceY, 1, 0.5);
	await pen("mouseReleased", practiceX + 30, practiceY, 0, 0, "left");
	const practiceInk = await pixels();
	await page.click(footerSelector + ' [data-file-path-input]');
	await page.type(footerSelector + ' [data-file-path-input]', "Keep this reasoning.");
	await page.screenshot({ path: path.join(output, "practice-writing.png") });
	await closeWriting();
	await page.click('[data-testid="practice-send"]');
	await page.waitForFunction(() => document.body.textContent.includes("Writing smoke rejected this send."));
	assert.equal(practiceAttempts.length, 1);
	assert.equal(await page.$$eval('[data-testid="practice-working"]', nodes => nodes.length), 0, "A refused send must not leave a history snapshot");
	assert.match(await page.$eval('[data-testid="practice-thinking-field"]', node => node.textContent), /Keep this reasoning/);
	await openWriting();
	assert(await pixels() === practiceInk, "A refused send preserves the editable ink");
	await closeWriting();
	const practiceField = '[data-testid="practice-thinking-field"] [data-file-path-input]';
	await page.click(practiceField);
	await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
	await page.keyboard.press("Backspace");
	refusePractice = false;
	await page.click('[data-testid="practice-send"]');
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="practice-working"]').length === 1 && !document.querySelector('[data-testid="practice-send"]').disabled);
	assert.equal(practiceSubmissions[0].text, "", "Practice supports image-only submission");
	const firstSnapshot = practiceSubmissions[0].workingImage.data;
	await openWriting();
	assert(await pixels() === practiceInk, "An accepted send keeps the same problem's ink editable");
	await pen("mousePressed", practiceX, practiceY + 40, 1, 0.5, "left");
	await pen("mouseMoved", practiceX + 30, practiceY + 40, 1, 0.5);
	await pen("mouseReleased", practiceX + 30, practiceY + 40, 0, 0, "left");
	await page.click(footerSelector + ' [data-file-path-input]');
	await page.type(footerSelector + ' [data-file-path-input]', "The second step completes it.");
	await closeWriting();
	await page.click('[data-testid="practice-send"]');
	await page.waitForSelector('[data-testid="practice-dock"][data-problem="practice-problem-2"]');
	assert.equal(practiceSubmissions.length, 2);
	assert.match(practiceSubmissions[1].text, /second step completes/);
	assert(practiceSubmissions[1].workingImage.data !== firstSnapshot, "A later submission snapshots the updated ink");
	assert.equal(await page.$$eval('[data-testid="practice-working"] img', images => images.length), 2);
	assert.equal(await page.$eval('[data-testid="practice-working"] img', image => image.src.split(",")[1]), firstSnapshot, "Later edits preserve the first submission's snapshot");
	assert(await page.$eval('[data-testid="practice-send"]', button => button.disabled), "A new problem starts with no text or attached ink");
	await openWriting();
	assert.equal(await page.$eval(canvasSelector, canvas => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.some((alpha, i) => i % 4 === 3 && alpha > 0)), false, "A new problem starts with a fresh sheet");
	await page.screenshot({ path: path.join(output, "practice-new-problem.png") });
	await closeWriting();
	await page.reload({ waitUntil: "networkidle2" });
	await page.waitForSelector('[data-testid="practice-working"]');
	assert.equal(await page.$$eval('[data-testid="practice-working"] img', images => images.length), 2, "Submitted practice snapshots survive reload");
	await page.screenshot({ path: path.join(output, "practice-history.png") });
	console.log("Practice supports image-only and combined sends, preserves refused drafts and same-problem ink, resets new problems, and restores history.");
	assert.deepEqual(errors, []);
	await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, repeatedCaptures, reopenPreservesInk: true, layout, hoverPreservesInk: true, footerGrowthDoesNotOverlap: true, imageExcludesFooter: true, practice: { rejectedDraftPreserved: true, imageOnly: true, combined: true, sameProblemInkPreserved: true, newProblemReset: true, historyRestored: true } }, null, 2));
	console.log("PASS: pen hover preserves ink, tall questions stay above the growing footer, and PNG export excludes live controls. Artifacts: " + output);
} catch (error) {
	await fs.writeFile(path.join(output, "server.log"), logs);
	if (page) await page.screenshot({ path: path.join(output, "failure.png") });
	throw error;
} finally {
	await browser?.close();
	child.kill("SIGTERM");
	await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
	await fs.rm(path.join(profile, "data"), { recursive: true, force: true });
	await fs.rm(path.join(profile, "auth.json"), { force: true });
}
