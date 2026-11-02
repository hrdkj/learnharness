/** Capture the complete question onto a blank sheet, independent of chat scrolling. */
export async function captureQuestionView(surface: HTMLElement, sheet: HTMLElement) {
	const question = surface.querySelector<HTMLElement>("[data-question-writing-content]");
	if (!question) throw new Error("The question is not available.");
	const { toSvg } = await import("html-to-image");
	await document.fonts.ready;
	const width = sheet.clientWidth;
	const height = sheet.clientHeight;
	const questionWidth = question.clientWidth;
	const questionHeight = question.scrollHeight;
	if (!width || !height || !questionWidth || !questionHeight) throw new Error("The question view is not visible.");
	// The clone starts at the top and expands to the full scroll height.
	// Only this question's nodes and fonts are processed, never the transcript.
	const svg = await toSvg(question, {
		width: questionWidth,
		height: questionHeight,
		style: { height: `${questionHeight}px`, maxHeight: "none", overflow: "visible" },
	});
	const source = new Image();
	source.src = svg;
	await source.decode();
	const canvas = document.createElement("canvas");
	const ratio = Math.min(window.devicePixelRatio || 1, 2);
	canvas.width = Math.round(width * ratio);
	canvas.height = Math.round(height * ratio);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Drawing is unavailable in this browser.");
	let ancestor: HTMLElement | null = surface;
	while (ancestor) {
		const color = getComputedStyle(ancestor).backgroundColor;
		if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
			context.fillStyle = color;
			context.fillRect(0, 0, canvas.width, canvas.height);
			break;
		}
		ancestor = ancestor.parentElement;
	}
	// Reserve the toolbar's row and fit every option without clipping.
	// Keep the question at its reading size when it already fits; the rest
	// of the sheet is free space for handwritten working.
	const margin = 24;
	const top = 64;
	const scale = Math.min(1, Math.max(1, width - margin * 2) / questionWidth, Math.max(1, height - top - margin) / questionHeight);
	context.setTransform(ratio, 0, 0, ratio, 0, 0);
	context.drawImage(source, margin, top, questionWidth * scale, questionHeight * scale);
	return { background: canvas.toDataURL("image/png"), width, height, pixelRatio: ratio, strokes: [] };
}
