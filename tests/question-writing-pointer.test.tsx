import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { QuestionWriting } from "../components/question-writing.tsx";
import { visibleWritingStrokes, type QuestionWritingDraft } from "../src/core/index.ts";

test("pen contact, held eraser, and coalesced samples preserve stroke boundaries", async (t) => {
	const dom = parseHTML("<html><body><div id='root' data-question-writing-surface></div></body></html>");
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({ React, window: dom.window, document: dom.document,
		HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
		CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
		saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
	}
	const canvasPrototype = dom.window.HTMLCanvasElement.prototype;
	t.mock.method(canvasPrototype, "getContext", () => ({
		resetTransform() {}, clearRect() {}, setTransform() {}, beginPath() {}, arc() {}, fill() {},
		moveTo() {}, lineTo() {}, stroke() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
	}));
	const capture = new Set<number>();
	const canvasMethods = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		setPointerCapture: (id: number) => capture.add(id),
		hasPointerCapture: (id: number) => capture.has(id),
		releasePointerCapture: (id: number) => capture.delete(id),
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
	})) {
		canvasMethods.set(name, Object.getOwnPropertyDescriptor(canvasPrototype, name));
		Object.defineProperty(canvasPrototype, name, { value, configurable: true });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	let draft: QuestionWritingDraft = {
		background: "data:image/png;base64,fixture", width: 100, height: 100,
		strokes: [{ tool: "pen", points: [{ x: 0, y: 20, pressure: 0.5 }, { x: 100, y: 20, pressure: 0.5 }] }],
		image: { mimeType: "image/png", data: "fixture" },
	};
	function Harness() {
		const [value, setValue] = useState(draft);
		draft = value;
		return <QuestionWriting draft={value} onChange={setValue} onActiveChange={() => {}} />;
	}
	try {
		await act(async () => { root.render(<Harness />); });
		await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="question-write"]')!.click(); });
		const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="question-writing-canvas"]')!;
		const pointer = async (type: string, x: number, y: number, buttons: number, button = -1,
			{ samples, pressure = buttons ? 0.5 : 0, pointerType = "pen" }: { samples?: object[]; pressure?: number; pointerType?: string } = {}) => {
			const event = Object.assign(new window.Event(type, { bubbles: true, cancelable: true }), {
				pointerId: 1, pointerType, pressure,
				clientX: x, clientY: y, button, buttons,
				getCoalescedEvents: () => samples ?? [],
			});
			await act(async () => { canvas.dispatchEvent(event); });
		};
		const undo = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "Undo")!;
		const original = structuredClone(draft);
		await pointer("pointerdown", 50, 80, 32, 5, { pressure: 0 });
		await pointer("pointermove", 50, 20, 32, -1, { pressure: 0 });
		await pointer("pointerup", 50, 20, 0, 5);
		assert.deepEqual(draft, original, "hovering with the eraser held must not alter ink or history");
		assert.equal(capture.size, 0);
		// A button can remain held across several separate tip contacts.
		await pointer("pointerdown", 10, 80, 32, 5, { pressure: 0 });
		await pointer("pointermove", 10, 80, 33, 0);
		await pointer("pointermove", 50, 20, 32, 0, { pressure: 0 });
		assert.equal(draft.strokes.length, 2, "lifting the tip commits the contact before button release");
		assert.equal(visibleWritingStrokes(draft.strokes).length, 1, "hover travel must not erase crossed ink");
		await pointer("pointermove", 90, 80, 33, 0);
		await pointer("pointermove", 90, 80, 32, 0, { pressure: 0 });
		await pointer("pointerup", 90, 20, 0, 5);
		assert.equal(draft.strokes.length, 3);
		assert.deepEqual(draft.strokes.slice(1).map(stroke => stroke.points.length), [1, 1], "separate contacts cannot bridge hover travel");
		assert.equal(visibleWritingStrokes(draft.strokes).length, 1);
		await act(async () => { undo.click(); });
		await act(async () => { undo.click(); });
		// Coalesced contact/lift/contact samples must also split pen strokes.
		await pointer("pointerdown", 10, 80, 1, 0);
		await pointer("pointermove", 90, 80, 3, -1, { samples: [
			{ clientX: 20, clientY: 80, pointerType: "pen", pressure: 0.5, buttons: 1 },
			{ clientX: 50, clientY: 20, pointerType: "pen", pressure: 0, buttons: 2 },
			{ clientX: 90, clientY: 80, pointerType: "pen", pressure: 0.5, buttons: 3 },
		] });
		await pointer("pointerup", 90, 20, 0, 2);
		assert.deepEqual(draft.strokes.slice(1).map(stroke => stroke.points.map(({ x, y }) => [x, y])), [
			[[10, 80], [20, 80]], [[90, 80]],
		]);
		await act(async () => { undo.click(); });
		await act(async () => { undo.click(); });
		// Mouse events retain their normal contact and final endpoint behavior.
		await pointer("pointerdown", 10, 90, 1, 0, { pointerType: "mouse", pressure: 0 });
		await pointer("pointerup", 20, 90, 0, 0, { pointerType: "mouse" });
		assert.deepEqual(draft.strokes.at(-1)!.points.map(({ x, y }) => [x, y]), [[10, 90], [20, 90]]);
		await act(async () => { undo.click(); });
		// Contact may begin with button=0 while the eraser bit is already held.
		await pointer("pointerdown", 50, 20, 33, 0);
		await pointer("pointerup", 50, 20, 0, 0);
		assert.equal(draft.strokes.at(-1)!.tool, "eraser");
		assert.equal(visibleWritingStrokes(draft.strokes).length, 0);
		await act(async () => { undo.click(); });
		assert.equal(visibleWritingStrokes(draft.strokes).length, 1);
		// Press/release while down, including several coalesced samples in one event.
		await pointer("pointerdown", 10, 80, 1, 0);
		await pointer("pointermove", 20, 80, 1);
		await pointer("pointermove", 70, 80, 1, -1, { samples: [
			{ clientX: 50, clientY: 20, pointerType: "pen", pressure: 0.5, buttons: 33, button: 5 },
			{ clientX: 70, clientY: 80, pointerType: "pen", pressure: 0.5, buttons: 1, button: 5 },
		] });
		await pointer("pointerup", 80, 80, 0, 0);
		assert.deepEqual(draft.strokes.map(stroke => stroke.tool), ["pen", "pen", "eraser", "pen"]);
		const visible = visibleWritingStrokes(draft.strokes);
		assert.equal(visible.length, 2, "the held eraser removes the old line but leaves separate pen segments");
		assert.equal(draft.strokes[2]!.points.length, 1, "tool changes must not bridge distant points with an eraser line");
		assert.equal(capture.size, 0);
		// A later contact returns to Pen; holding the button never toggles the toolbar.
		await pointer("pointerdown", 90, 90, 1, 0);
		await pointer("pointerup", 90, 90, 0, 0);
		assert.equal(draft.strokes.at(-1)!.tool, "pen");
		const eraser = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "Eraser")!;
		await act(async () => { eraser.click(); });
		await pointer("pointerdown", 0, 0, 33, 5);
		await pointer("pointermove", 0, 1, 1, 5);
		await pointer("pointerup", 0, 2, 0, 0);
		assert.equal(draft.strokes.at(-1)!.tool, "eraser", "release restores the selected toolbar tool");
	} finally {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of canvasMethods) {
			if (descriptor) Object.defineProperty(canvasPrototype, name, descriptor);
			else Reflect.deleteProperty(canvasPrototype, name);
		}
		for (const [name, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
});
