/** The submitted working is a native image, never base64 inside model text. */
export interface QuestionWorkingImage {
	mimeType: "image/png";
	data: string;
}

export interface WritingPoint {
	x: number;
	y: number;
	pressure: number;
}

export interface WritingStroke {
	tool: "pen" | "eraser";
	points: WritingPoint[];
}

export function writingStrokeWidth(a: WritingPoint, b: WritingPoint): number {
	return 1.5 + 3 * (a.pressure + b.pressure) / 2;
}

function pointSegmentDistanceSquared(point: WritingPoint, a: WritingPoint, b: WritingPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
	return (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2;
}

function segmentDistanceSquared(a: WritingPoint, b: WritingPoint, c: WritingPoint, d: WritingPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const ex = d.x - c.x;
	const ey = d.y - c.y;
	const determinant = dx * ey - dy * ex;
	if (determinant !== 0) {
		const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / determinant;
		const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / determinant;
		if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
	}
	return Math.min(
		pointSegmentDistanceSquared(a, c, d), pointSegmentDistanceSquared(b, c, d),
		pointSegmentDistanceSquared(c, a, b), pointSegmentDistanceSquared(d, a, b),
	);
}

function touchesStroke(stroke: WritingStroke, eraser: WritingStroke): boolean {
	for (let i = 0; i < stroke.points.length; i++) {
		const a = stroke.points[Math.max(0, i - 1)]!;
		const b = stroke.points[i]!;
		// Keep the existing 24px eraser contact area, including the ink's edge.
		const radius = 12 + writingStrokeWidth(a, b) / 2;
		for (let j = 0; j < eraser.points.length; j++) {
			const c = eraser.points[Math.max(0, j - 1)]!;
			const d = eraser.points[j]!;
			if (segmentDistanceSquared(a, b, c, d) <= radius * radius) return true;
		}
	}
	return false;
}

/** Eraser gestures stay in history so Undo restores their complete strokes. */
export function visibleWritingStrokes(history: readonly WritingStroke[]): WritingStroke[] {
	let visible: WritingStroke[] = [];
	for (const stroke of history) {
		if (stroke.tool === "pen") visible.push(stroke);
		else visible = visible.filter((pen) => !touchesStroke(pen, stroke));
	}
	return visible;
}

/** In-memory only: enough to reopen the same frozen view and undo strokes. */
export interface QuestionWritingDraft {
	background: string;
	width: number;
	height: number;
	pixelRatio?: number;
	strokes: WritingStroke[];
	image?: QuestionWorkingImage;
}

export function isQuestionWorkingImage(value: unknown): value is QuestionWorkingImage {
	if (!value || typeof value !== "object") return false;
	const image = value as Partial<QuestionWorkingImage>;
	return image.mimeType === "image/png" && typeof image.data === "string"
		&& image.data.length <= 16 * 1024 * 1024
		&& image.data.startsWith("iVBORw0KGgo")
		&& image.data.length % 4 === 0
		&& /^[A-Za-z0-9+/]+={0,2}$/.test(image.data);
}
