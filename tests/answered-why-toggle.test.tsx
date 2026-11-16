import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AnsweredCard, currentWhyOpen, setAllWhyOpen } from "../components/answered-card.tsx";
import { actionForBinding, bindingForAction, kbdEventForAction } from "../src/core/keyboard.ts";
import type { QuestionAnswerData } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
const storage = new Map<string, string>();
const localStorage = {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => void storage.set(key, value),
	removeItem: (key: string) => void storage.delete(key),
};
Object.defineProperty(dom.window, "localStorage", { value: localStorage, configurable: true });
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const answer = (explanation: string): QuestionAnswerData => ({
	kind: "quiz", questionText: "Which planet is closest to the Sun?",
	options: [{ index: 0, label: "Mercury" }, { index: 1, label: "Venus" }],
	answers: [{ index: 0, label: "Mercury", value: "Mercury" }] as QuestionAnswerData["answers"],
	correct: true, explanation, dontKnow: false, answeredAt: "2026-11-16T00:00:00.000Z",
} as QuestionAnswerData);

test("mod+y is the toggle-why action", () => {
	assert.equal(actionForBinding("mod+y"), "toggle-why");
	assert.equal(bindingForAction("toggle-why"), "mod+y");
	assert.equal(kbdEventForAction("toggle-why"), "lh:kbd-toggle-why");
});

test("Toggle all Why opens/closes every card, overrides per-card clicks, and is remembered", async () => {
	// A previous launch left every Why open.
	storage.set("lh:answered-why-open", "1");
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const shown = () => [...host.querySelectorAll('[data-testid="tucked-explanation"]')].map(card => card.textContent?.includes("Why: ") ?? false);
	const whyButtons = () => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="tucked-explanation"] > button')];
	try {
		await act(async () => root.render(<>
			<AnsweredCard answer={answer("First reason.")} />
			<AnsweredCard answer={answer("Second reason.")} />
		</>));
		assert.deepEqual(shown(), [true, true], "the remembered open state applies on mount");
		assert.equal(currentWhyOpen(), true);

		// The per-card button still works on its own.
		await act(async () => whyButtons()[0]!.click());
		assert.deepEqual(shown(), [false, true]);

		// Toggling all closes every card and is saved.
		await act(async () => setAllWhyOpen(!currentWhyOpen()));
		assert.deepEqual(shown(), [false, false]);
		assert.equal(storage.get("lh:answered-why-open"), "0");

		// An individually opened card is stomped by the next explicit set.
		await act(async () => whyButtons()[1]!.click());
		assert.deepEqual(shown(), [false, true]);
		await act(async () => setAllWhyOpen(!currentWhyOpen()));
		assert.deepEqual(shown(), [true, true]);
		assert.equal(storage.get("lh:answered-why-open"), "1");

		// Cards mounted later (another session) honor the last set.
		await act(async () => root.render(<AnsweredCard answer={answer("Third reason.")} />));
		assert.deepEqual(shown(), [true]);
	} finally { await act(async () => root.unmount()); host.remove(); }
});
