import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { QuestionWriting } from "../components/question-writing.tsx";
import { isDictationActive, setDictationActive } from "../components/dictation-state.ts";
import { actionForBinding, eventBinding, type QuestionWritingDraft } from "../src/core/index.ts";

test("Write preserves global shortcuts and cancels dictation before closing", async (t) => {
	const dom = parseHTML("<html><body><div id='root' data-question-writing-surface></div></body></html>");
	// Advertise native input events before React selects its event support path.
	Object.defineProperty(dom.document, "oninput", { value: null });
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({ React, window: dom.window, document: dom.document,
		HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
		CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
		saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
	}
	t.mock.method(dom.window.HTMLCanvasElement.prototype, "getContext", () => ({
		resetTransform() {}, clearRect() {}, setTransform() {},
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
	}));
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	let active = false, cancellations = 0;
	const actions: string[] = [];
	// Exercise propagation to the existing window-level keyboard dispatcher.
	const dispatch = (event: KeyboardEvent) => {
		if (event.key === "Tab") {
			event.preventDefault();
			if (event.shiftKey) actions.push("cycle-thinking");
			return;
		}
		const action = actionForBinding(eventBinding(event));
		if (action) actions.push(action);
	};
	const cancel = () => { cancellations++; setDictationActive(false); };
	window.addEventListener("keydown", dispatch);
	window.addEventListener("lh:kbd-cancel-dictation", cancel);
	function Harness() {
		const [draft, setDraft] = useState<QuestionWritingDraft>({
			background: "data:image/png;base64,fixture", width: 100, height: 100, strokes: [],
			image: { mimeType: "image/png", data: "fixture" },
		});
		return <QuestionWriting draft={draft} onChange={setDraft} onActiveChange={value => { active = value; }}
			controls={<textarea data-testid="reasoning" />} />;
	}
	const press = async (target: Element, key: string, modifiers: Record<string, boolean> = {}) => {
		const event = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key, ...modifiers });
		await act(async () => { target.dispatchEvent(event); });
		return event;
	};
	try {
		await act(async () => { root.render(<Harness />); });
		await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="question-write"]')!.click(); });
		assert.equal(active, true);
		const dialog = document.querySelector('[role="dialog"]')!;
		const toolbar = dialog.querySelector("button")!;
		const field = dialog.querySelector("textarea")!;
		for (const target of [dialog, toolbar, field]) {
			await press(target, "d", { ctrlKey: true });
			await press(target, "Tab", { shiftKey: true });
		}
		assert.deepEqual(actions, ["toggle-dictation", "cycle-thinking", "toggle-dictation", "cycle-thinking", "toggle-dictation", "cycle-thinking"]);
		for (const target of [dialog, toolbar, field]) {
			setDictationActive(true);
			const escape = await press(target, "Escape");
			assert.equal(escape.defaultPrevented, true);
			assert.equal(isDictationActive(), false);
			assert.equal(active, true, "cancelling dictation keeps Write open");
		}
		assert.equal(cancellations, 3);
		await press(field, "Escape");
		assert.equal(active, false, "Escape closes Write once dictation is idle");
		assert.equal(document.querySelector('[role="dialog"]'), null);
		assert.equal(cancellations, 3);
	} finally {
		await act(async () => { root.unmount(); });
		setDictationActive(false);
		window.removeEventListener("keydown", dispatch);
		window.removeEventListener("lh:kbd-cancel-dictation", cancel);
		for (const [name, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
});
