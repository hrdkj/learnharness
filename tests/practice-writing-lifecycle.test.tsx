import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { PracticeDock, type PracticeDockProps } from "../components/practice-dock.tsx";
import { appendToPrimaryInput } from "../components/dictation.tsx";
import { setDictationActive } from "../components/dictation-state.ts";

test("practice writing releases its active state on collapse and cancels a replaced problem's pending send", async () => {
	const dom = parseHTML('<html><body><div id="root" data-question-writing-surface></div></body></html>');
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({ React, window: dom.window, document: dom.document,
		Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
		HTMLButtonElement: dom.window.HTMLButtonElement, CustomEvent: dom.window.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true })) {
		saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
	}
	// Hold capture pending so collapse also exercises late-capture cancellation.
	Object.defineProperty(document, "fonts", { value: { ready: new Promise(() => {}) } });
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const submissions: Array<{ problemCallId: string; text: string }> = [];
	const onSubmit: PracticeDockProps["onSubmit"] = async (problemCallId, text) => {
		submissions.push({ problemCallId, text });
		return true;
	};
	const view = (id: string, expanded = true) => <PracticeDock key={id} problemCallId={id}
		input={{ statement: id }} expanded={expanded} onExpand={() => {}} onSubmit={onSubmit} />;
	const send = () => document.querySelector<HTMLButtonElement>('[data-testid="practice-send"]')!;
	try {
		await act(async () => { root.render(view("first")); });
		await act(async () => { appendToPrimaryInput("my reasoning"); });
		await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="question-write"]')!.click(); });
		assert.equal(send().disabled, true, "Write owns Enter and blocks sending");
		await act(async () => { root.render(view("first", false)); });
		await act(async () => { root.render(view("first")); });
		assert.equal(document.querySelector('[data-testid="question-writing-overlay"]'), null);
		assert.equal(send().disabled, false, "collapse must release Write's submission guard");
		await act(async () => { send().click(); });
		assert.deepEqual(submissions, [{ problemCallId: "first", text: "my reasoning" }]);

		await act(async () => { appendToPrimaryInput("old problem reasoning"); });
		setDictationActive(true);
		act(() => {
			send().click();
			root.render(view("replacement"));
		});
		await act(async () => { await Promise.resolve(); });
		assert.equal(submissions.length, 1, "a pending send must be cancelled when its problem unmounts");
		setDictationActive(false);
		await act(async () => { appendToPrimaryInput("new problem reasoning"); });
		await act(async () => { send().click(); });
		assert.deepEqual(submissions[1], { problemCallId: "replacement", text: "new problem reasoning" });
	} finally {
		setDictationActive(false);
		await act(async () => root.unmount());
		for (const [name, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
});
