import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { piModels } from "../src/agent/models.ts";
import {
	buildAnswer, parseChatInput, newAnswerResult, projectView, toLlmMessages,
	visibleWritingStrokes,
	type LhMessage, type QuestionData, type QuestionAnswerData, type QuestionWorkingImage, type WritingStroke,
} from "../src/core/index.ts";
import { SessionModel } from "../components/session-core.ts";

const image: QuestionWorkingImage = {
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
};
const question: QuestionData = {
	id: "working-q", kind: "quiz", question: "What is 2 + 2?", mode: "single-select",
	options: [{ label: "4", value: "four" }, { label: "5", value: "five" }],
	correctIndices: [1], createdAt: "fixture",
};
const call = {
	id: "question-message", role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-5",
	content: [{ type: "toolCall", id: question.id, name: "quiz", arguments: { question: question.question } }],
	stopReason: "toolUse", timestamp: 1,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} as LhMessage;

function stroke(tool: WritingStroke["tool"], coordinates: number[][], pressure = 0.5): WritingStroke {
	return { tool, points: coordinates.map(([x, y]) => ({ x: x!, y: y!, pressure })) };
}

test("touching the middle removes an entire stroke while leaving nearby strokes intact", () => {
	const line = stroke("pen", [[0, 0], [100, 0]]);
	const neighbor = stroke("pen", [[0, 40], [100, 40]]);
	const eraser = stroke("eraser", [[50, 0]]);
	const history = [line, neighbor, eraser];
	const before = structuredClone(history);
	assert.deepEqual(visibleWritingStrokes(history), [neighbor]);
	assert.deepEqual(history, before, "erasing does not destroy the Undo history");
});

test("an eraser drag removes every crossed stroke even when samples fall between them", () => {
	const first = stroke("pen", [[0, 0], [100, 0]]);
	const second = stroke("pen", [[0, 40], [100, 40]]);
	const untouched = stroke("pen", [[150, 0], [200, 0]]);
	const eraser = stroke("eraser", [[50, -50], [50, 90]]);
	const history = [first, second, untouched, eraser];
	assert.deepEqual(visibleWritingStrokes(history), [untouched]);
	assert.deepEqual(visibleWritingStrokes(history.slice(0, -1)), [first, second, untouched], "Undo restores all strokes erased by one drag");
});

test("eraser contact includes pen thickness and handles single-point dots", () => {
	const dot = stroke("pen", [[50, 0]], 1);
	assert.deepEqual(visibleWritingStrokes([dot, stroke("eraser", [[50, 14]])]), []);
	assert.deepEqual(visibleWritingStrokes([dot, stroke("eraser", [[50, 15]])]), [dot]);
	assert.deepEqual(visibleWritingStrokes([dot, stroke("eraser", [[50, 0]])]), []);
});

test("distant collinear segments and crossings beyond the stroke do not erase it", () => {
	const line = stroke("pen", [[0, 0], [10, 0]]);
	assert.deepEqual(visibleWritingStrokes([line, stroke("eraser", [[100, 0], [110, 0]])]), [line]);
	assert.deepEqual(visibleWritingStrokes([line, stroke("eraser", [[50, -50], [50, 50]])]), [line]);
});

test("writing after an erasing gesture remains visible, and Undo removes the latest action", () => {
	const first = stroke("pen", [[0, 0], [100, 0]]);
	const eraser = stroke("eraser", [[50, 0]]);
	const later = stroke("pen", [[0, 0], [100, 0]]);
	assert.deepEqual(visibleWritingStrokes([first, eraser, later]), [later]);
	assert.deepEqual(visibleWritingStrokes([first, eraser]), []);
	assert.deepEqual(visibleWritingStrokes([first]), [first]);
});

test("handwritten working survives submission, native persistence, history projection, and Responses image conversion", () => {
	const answer = buildAnswer(question, { values: ["four"], confidence: 70, thinking: "two pairs", workingImage: image });
	const input = parseChatInput(JSON.parse(JSON.stringify({ type: "answer", toolCallId: question.id, answer })));
	assert.equal(input.type, "answer");
	if (input.type !== "answer") return;
	const result = newAnswerResult(question.id, "quiz", input.answer);
	assert.deepEqual(result.content[1], { type: "image", ...image });
	assert.equal((result.details as unknown as QuestionAnswerData).workingImage, undefined, "the PNG is stored once");
	assert.ok(!JSON.stringify(result.content[0]).includes(image.data), "base64 never becomes model text");
	const record = JSON.parse(JSON.stringify([call, result])) as LhMessage[];
	const output = projectView(record).flatMap((m) => m.parts).find((p) => p.toolCallId === question.id)!.output as QuestionAnswerData;
	assert.deepEqual(output.workingImage, image);
	assert.equal(output.answers[0]!.value, "four");
	assert.equal(output.thinking, "two pairs");
	const wire = convertResponsesMessages(piModels().getModel("openai", "gpt-5")!, normalizeContext({ messages: toLlmMessages(record) }), new Set(["openai"]));
	const toolOutput = wire.find((item) => item.type === "function_call_output");
	assert.ok(toolOutput && "output" in toolOutput && Array.isArray(toolOutput.output));
	assert.ok(toolOutput.output.some((part) => part.type === "input_image" && part.image_url === `data:image/png;base64,${image.data}`));
});

test("an answer without handwriting retains its existing text-only shape", () => {
	const answer = buildAnswer(question, { values: ["four"] });
	assert.ok(!("workingImage" in answer));
	const result = newAnswerResult(question.id, "quiz", answer);
	assert.equal(result.content.length, 1);
	assert.equal(result.details, answer);
});

test("malformed image inputs are rejected before they enter the record", () => {
	const answer = buildAnswer(question, { values: ["four"] });
	for (const workingImage of [null, {}, { ...image, mimeType: "image/svg+xml" }, { ...image, data: "not-a-png" }, { ...image, data: image.data + "!!!" }]) {
		assert.throws(() => parseChatInput({ type: "answer", toolCallId: question.id, answer: { ...answer, workingImage } }), /workingImage must be a PNG/);
	}
});

test("a failed submission preserves the frozen drawing and image for the same question", async () => {
	const answer = buildAnswer(question, { values: ["four"], workingImage: image });
	let submitted: unknown;
	const model = new SessionModel({ chatId: "working-fixture", initialMessages: [call], fetch: async (_url, init) => {
		submitted = JSON.parse(init!.body as string);
		throw new TypeError("offline");
	} });
	const writing = { background: `data:image/png;base64,${image.data}`, width: 100, height: 100, strokes: [{ tool: "pen" as const, points: [{ x: 10, y: 10, pressure: 0.5 }] }], image };
	const form = { writing, selection: { selected: new Set([0]), otherSelected: false, dontKnow: false }, thinking: "", other: "", text: "", confidenceIndex: 2 };
	model.saveQuestionDraft(question.id, { form });
	await model.submitAnswer("quiz", question.id, answer);
	assert.equal(model.status, "error");
	assert.deepEqual((submitted as { input: { answer: QuestionAnswerData } }).input.answer.workingImage, image);
	assert.deepEqual(model.questionDraft(question.id)?.form?.writing, writing);
	assert.equal(model.getState().messages.flatMap((m) => m.parts).find((p) => p.toolCallId === question.id)!.state, "input-available");
});
