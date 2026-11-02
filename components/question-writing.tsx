"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EraserIcon, PencilIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import type { QuestionWritingDraft, WritingPoint, WritingStroke } from "@/src/core";
import { visibleWritingStrokes, writingStrokeWidth } from "@/src/core";
import { captureQuestionView } from "@/components/question-writing-capture";
import { isDictationActive } from "@/components/dictation-state";

function segment(context: CanvasRenderingContext2D, a: WritingPoint, b: WritingPoint) {
	context.globalCompositeOperation = "source-over";
	context.strokeStyle = "#facc15";
	context.fillStyle = "#facc15";
	context.lineCap = "round";
	context.lineJoin = "round";
	context.lineWidth = writingStrokeWidth(a, b);
	context.beginPath();
	if (a.x === b.x && a.y === b.y) {
		context.arc(a.x, a.y, context.lineWidth / 2, 0, Math.PI * 2);
		context.fill();
	} else {
		context.moveTo(a.x, a.y);
		context.lineTo(b.x, b.y);
		context.stroke();
	}
}

function repaint(canvas: HTMLCanvasElement, draft: QuestionWritingDraft, active?: WritingStroke) {
	const context = canvas.getContext("2d")!;
	context.resetTransform();
	context.clearRect(0, 0, canvas.width, canvas.height);
	context.setTransform(canvas.width / draft.width, 0, 0, canvas.height / draft.height, 0, 0);
	for (const stroke of visibleWritingStrokes(active ? [...draft.strokes, active] : draft.strokes)) {
		stroke.points.forEach((point, i) => segment(context, stroke.points[Math.max(0, i - 1)]!, point));
	}
}

const control = "flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-2 text-xs text-foreground hover:bg-accent aria-pressed:border-primary/60 aria-pressed:bg-accent disabled:cursor-default disabled:opacity-40";

export function QuestionWriting({ draft, onChange, onActiveChange, controls, onThinkingTargetChange }: {
	draft?: QuestionWritingDraft;
	onChange: (draft: QuestionWritingDraft) => void;
	onActiveChange: (active: boolean) => void;
	controls?: ReactNode;
	onThinkingTargetChange?: (target: HTMLDivElement | null) => void;
}) {
	const [surface, setSurface] = useState<HTMLElement | null>(null);
	const [capturing, setCapturing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [tool, setTool] = useState<WritingStroke["tool"]>("pen");
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const sheetRef = useRef<HTMLDivElement>(null);
	const backgroundRef = useRef<HTMLImageElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const strokeRef = useRef<WritingStroke | null>(null);
	// A pen's buttons can keep its pointer active between tip contacts.
	const pointerIdRef = useRef<number | null>(null);
	const generation = useRef(0);
	const closing = useRef(false);
	const current = useRef(draft);
	current.current = draft;
	const activeChangeRef = useRef(onActiveChange);
	activeChangeRef.current = onActiveChange;
	useEffect(() => () => { generation.current++; activeChangeRef.current(false); }, []);

	const undo = useCallback(() => {
		const value = current.current;
		if (value && !strokeRef.current) onChange({ ...value, strokes: value.strokes.slice(0, -1), image: undefined });
	}, [onChange]);

	const close = useCallback(async () => {
		if (strokeRef.current || closing.current) return;
		closing.current = true;
		const value = current.current;
		try {
			if (value && canvasRef.current) {
				const ink = canvasRef.current;
				const pixels = ink.getContext("2d")!.getImageData(0, 0, ink.width, ink.height).data;
				const hasInk = pixels.some((alpha, i) => i % 4 === 3 && alpha > 0);
				let image: QuestionWritingDraft["image"];
				if (hasInk) {
					const background = backgroundRef.current!;
					await background.decode();
					const combined = document.createElement("canvas");
					combined.width = ink.width;
					combined.height = ink.height;
					const context = combined.getContext("2d")!;
					context.drawImage(background, 0, 0, combined.width, combined.height);
					context.drawImage(ink, 0, 0);
					image = { mimeType: "image/png", data: combined.toDataURL("image/png").split(",")[1]! };
				}
				onChange({ ...value, image });
			}
			generation.current++;
			pointerIdRef.current = null;
			setSurface(null);
			setCapturing(false);
			onActiveChange(false);
			triggerRef.current?.focus();
		} catch {
			setError("Could not save your working. Your drawing is still here; try Interact again.");
		} finally {
			closing.current = false;
		}
	}, [onChange, onActiveChange]);

	const open = () => {
		const target = triggerRef.current?.closest<HTMLElement>("[data-question-writing-surface]");
		if (!target) return;
		setError(null);
		setSurface(target);
		onActiveChange(true);
		// An empty sheet can still have an erasing gesture to undo.
		if (current.current?.image || current.current?.strokes.length) return;
		setCapturing(true);
	};

	useEffect(() => {
		if (!surface || !capturing || !sheetRef.current) return;
		const sheet = sheetRef.current;
		const attempt = ++generation.current;
		void (async () => {
			try {
				const snapshot = await captureQuestionView(surface, sheet);
				if (generation.current === attempt) onChange(snapshot);
			} catch {
				if (generation.current !== attempt) return;
				setSurface(null);
				onActiveChange(false);
				setError("Could not capture the question. Please try Write again.");
			} finally {
				if (generation.current === attempt) setCapturing(false);
			}
		})();
		return () => { if (generation.current === attempt) generation.current++; };
	}, [surface, capturing, onChange, onActiveChange]);

	useEffect(() => {
		if (surface && draft && canvasRef.current) repaint(canvasRef.current, draft, strokeRef.current ?? undefined);
	}, [surface, draft]);

	useEffect(() => {
		if (!surface) return;
		dialogRef.current?.focus();
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				if (isDictationActive()) window.dispatchEvent(new CustomEvent("lh:kbd-cancel-dictation"));
				else void close();
				return;
			}
			// Tab and global shortcuts keep the page's existing keyboard map.
			if (event.key === "Tab") return;
			// Let the live reasoning field handle typing and text undo.
			// Its parent blocks submission while ink is being edited.
			if (event.target instanceof HTMLElement && dialogRef.current?.contains(event.target) &&
				event.target.matches("textarea, input, [contenteditable=true]")) return;
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
				event.preventDefault(); event.stopPropagation(); undo();
			} else if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "Enter" || event.key === " ")) {
				event.preventDefault();
				event.stopPropagation();
				if (event.target instanceof HTMLButtonElement && dialogRef.current?.contains(event.target)) event.target.click();
			}
		};
		const wheel = (event: WheelEvent) => event.preventDefault();
		document.addEventListener("keydown", key, true);
		surface.addEventListener("wheel", wheel, { passive: false });
		return () => { document.removeEventListener("keydown", key, true); surface.removeEventListener("wheel", wheel); };
	}, [surface, close, undo]);

	const point = (event: PointerEvent | React.PointerEvent<HTMLCanvasElement>): WritingPoint => {
		const rect = canvasRef.current!.getBoundingClientRect();
		return {
			x: (event.clientX - rect.left) * current.current!.width / rect.width,
			y: (event.clientY - rect.top) * current.current!.height / rect.height,
			pressure: event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5,
		};
	};
	const commitStroke = () => {
		const active = strokeRef.current;
		if (!active) return;
		strokeRef.current = null;
		const value = { ...current.current!, strokes: [...current.current!.strokes, active], image: undefined };
		current.current = value;
		onChange(value);
	};
	const startStroke = (canvas: HTMLCanvasElement, event: PointerEvent | React.PointerEvent<HTMLCanvasElement>) => {
		const stroke: WritingStroke = { tool: (event.buttons & 32) !== 0 ? "eraser" : tool, points: [point(event)] };
		strokeRef.current = stroke;
		if (stroke.tool === "eraser") repaint(canvas, current.current!, stroke);
		else segment(canvas.getContext("2d")!, stroke.points[0]!, stroke.points[0]!);
	};
	const finishStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
		if (pointerIdRef.current !== event.pointerId) return;
		const active = strokeRef.current;
		// Pen pointerup may be a button release after the tip already lifted.
		if (active && event.type === "pointerup" && event.pointerType !== "pen") {
			const last = point(event);
			if (active.tool === "pen") segment(event.currentTarget.getContext("2d")!, active.points.at(-1)!, last);
			active.points.push(last);
			if (active.tool === "eraser") repaint(event.currentTarget, current.current!, active);
		}
		commitStroke();
		pointerIdRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
	};

	return <>
		<div data-writing-controls="" className="flex items-center gap-2">
			<button ref={triggerRef} type="button" data-testid="question-write" className={control} onClick={open}>
				<PencilIcon className="size-3.5" aria-hidden /> {draft?.image ? "Write · working attached" : "Write"}
			</button>
			{error && !surface && <span role="alert" className="text-xs text-destructive">{error}</span>}
		</div>
		{surface && createPortal(
			<div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Write on the question" tabIndex={-1}
				data-writing-controls="" data-testid="question-writing-overlay"
				className="absolute inset-0 z-50 flex flex-col overflow-hidden bg-background outline-none">
				<div ref={sheetRef} data-testid="question-writing-sheet" className="relative min-h-0 flex-1 overflow-hidden">
					{draft && <>
						{/* The background and ink always share the frozen view's coordinates. */}
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img ref={backgroundRef} src={draft.background} alt="Frozen question view" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full" />
						<canvas ref={canvasRef} data-testid="question-writing-canvas" aria-label="Handwriting surface"
							width={Math.round(draft.width * (draft.pixelRatio ?? 1))}
							height={Math.round(draft.height * (draft.pixelRatio ?? 1))}
							className="absolute inset-0 h-full w-full cursor-default touch-none select-none"
							onPointerDown={(event) => {
								if (capturing || closing.current || pointerIdRef.current !== null || event.pointerType === "touch" || (event.pointerType !== "pen" && event.button !== 0)) return;
								event.preventDefault();
								pointerIdRef.current = event.pointerId;
								event.currentTarget.setPointerCapture(event.pointerId);
								if (event.pointerType !== "pen" || event.pressure > 0) startStroke(event.currentTarget, event);
							}}
							onPointerMove={(event) => {
								if (capturing || closing.current || pointerIdRef.current !== event.pointerId) return;
								const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
								for (const sample of samples.length ? samples : [event.nativeEvent]) {
									if (sample.pointerType === "pen" && sample.pressure <= 0) {
										commitStroke();
										continue;
									}
									const active = strokeRef.current;
									if (!active) {
										startStroke(event.currentTarget, sample);
										continue;
									}
									const next = point(sample);
									// Chorded pen-button changes arrive as pointermove. The bitmask
									// reports what is held, including release events with button=5.
									const nextTool = (sample.buttons & 32) !== 0 ? "eraser" : tool;
									if (active.tool !== nextTool) {
										commitStroke();
										// Start at this sample: joining tools would erase or draw
										// across the gap from the previous tool's last point.
										startStroke(event.currentTarget, sample);
										continue;
									}
									if (active.tool === "pen") segment(event.currentTarget.getContext("2d")!, active.points.at(-1)!, next);
									active.points.push(next);
								}
								if (strokeRef.current?.tool === "eraser") repaint(event.currentTarget, current.current!, strokeRef.current);
							}}
							onPointerUp={finishStroke} onPointerCancel={finishStroke} onLostPointerCapture={finishStroke}
							onContextMenu={(event) => event.preventDefault()} />
					</>}
					{capturing && <div role="status" className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">Preparing writing surface…</div>}
					<div className="absolute right-3 top-3 flex flex-wrap justify-end gap-1.5 rounded-lg border bg-background/95 p-1.5 shadow-lg" aria-label="Writing tools">
						<button type="button" className={control} aria-pressed={tool === "pen"} disabled={capturing} onClick={() => setTool("pen")}><PencilIcon className="size-3.5" /> Pen</button>
						<button type="button" className={control} aria-pressed={tool === "eraser"} disabled={capturing} onClick={() => setTool("eraser")}><EraserIcon className="size-3.5" /> Eraser</button>
						<button type="button" className={control} disabled={capturing || !draft?.strokes.length} onClick={undo}><Undo2Icon className="size-3.5" /> Undo</button>
						<button type="button" className={control} disabled={capturing || !draft?.strokes.length} onClick={() => { if (draft) onChange({ ...draft, strokes: [], image: undefined }); }}><Trash2Icon className="size-3.5" /> Clear</button>
						<button type="button" className={control} data-testid="question-writing-interact" onClick={() => void close()}>Interact</button>
					</div>
					{error && <div role="alert" className="absolute top-16 left-3 right-3 rounded-md border bg-background p-3 text-sm text-destructive">{error}</div>}
				</div>
				{/* UI stays outside both the frozen question and the ink canvas.
				    close() composites those two image layers only. */}
				{(controls || onThinkingTargetChange) && <div data-writing-controls="" data-testid="question-writing-thinking"
					className="mx-auto mb-3 w-[calc(100%-1.5rem)] max-w-2xl shrink-0 rounded-2xl border bg-card p-2 shadow-lg">
					<div ref={onThinkingTargetChange} />
					{controls}
				</div>}
			</div>, surface)}
	</>;
}

/** Move the existing field without duplicating its state or dictation claim. */
export function WritingThinkingPortal({ target, children }: { target: HTMLElement | null; children: ReactNode }) {
	return target ? createPortal(children, target) : children;
}
