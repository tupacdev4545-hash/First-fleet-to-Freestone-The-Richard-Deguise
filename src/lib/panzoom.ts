// Pan and pinch-zoom for the tree canvas, built on Pointer Events.
//
// Fixes the "temperamental, randomly zooms all the way out" behaviour:
//  - Zoom is measured against the finger distance when the pinch started, and
//    pinned to the point between the fingers, so the tree doesn't drift.
//  - Lifting or adding a finger re-baselines instead of jumping.
//  - The browser's own page zoom is switched off over the canvas, so Safari
//    and the tree stop fighting over the same gesture.
//  - Taps still reach people on the tree; a drag only starts after 6px.
//  - No double-tap reset.
//
// The other half of the fix is in the README: stop re-fitting the tree on
// every resize event (the iPhone address bar firing resize is the most likely
// cause of the sudden zoom-out).
//
// Usage:
//   const pz = attachPanZoom(canvasEl, {
//     initial: { x, y, k },
//     onChange: (v) => { layer.style.transform =
//       `translate(${v.x}px, ${v.y}px) scale(${v.k})`; },
//   });
//   pz.set(view)      // e.g. jump to a person
//   pz.destroy()

export interface View { x: number; y: number; k: number }

export function attachPanZoom(
  el: HTMLElement,
  {
    initial = { x: 0, y: 0, k: 1 },
    minScale = 0.05,
    maxScale = 4,
    onChange,
  }: {
    initial?: View;
    minScale?: number;
    maxScale?: number;
    onChange: (v: View) => void;
  },
) {
  let view = { ...initial };
  const clamp = (k: number) => Math.min(maxScale, Math.max(minScale, k));

  // Stop the browser handling pinch and scroll here; the page itself keeps
  // working everywhere else.
  el.style.touchAction = "none";
  (el.style as any).webkitUserSelect = "none";
  el.style.userSelect = "none";

  // Draw at most once per frame.
  let frame = 0;
  const emit = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; onChange(view); });
  };

  const pointers = new Map<number, { x: number; y: number }>();
  let start: { view: View; mid: { x: number; y: number }; dist: number } | null = null;
  let dragging = false;
  let suppressClick = false;
  let downAt: { x: number; y: number } | null = null;

  const local = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function rebaseline() {
    const pts = [...pointers.values()];
    if (pts.length === 0) { start = null; return; }
    const mid = pts.length === 1 ? pts[0] : {
      x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2,
    };
    const dist = pts.length === 1 ? 0 : Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    start = { view: { ...view }, mid, dist };
  }

  function onDown(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) { downAt = local(e); dragging = false; suppressClick = false; }
    if (pointers.size === 2) startDrag(e);  // a pinch is always a gesture
    rebaseline();
  }

  function startDrag(e: PointerEvent) {
    if (dragging) return;
    dragging = true;
    suppressClick = true;
    for (const id of pointers.keys()) {
      try { el.setPointerCapture(id); } catch { /* pointer already gone */ }
    }
    el.setPointerCapture?.(e.pointerId);
  }

  function onMove(e: PointerEvent) {
    if (!pointers.has(e.pointerId) || !start) return;
    pointers.set(e.pointerId, local(e));

    if (!dragging) {
      const p = local(e);
      if (downAt && Math.hypot(p.x - downAt.x, p.y - downAt.y) < 6) return;
      startDrag(e);
    }

    const pts = [...pointers.values()];
    const s = start;
    if (pts.length === 1) {
      view = { ...s.view, x: s.view.x + pts[0].x - s.mid.x, y: s.view.y + pts[0].y - s.mid.y };
    } else {
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (s.dist < 10) return;  // fingers too close together to measure
      const k = clamp(s.view.k * (dist / s.dist));
      // The tree point that was under the fingers at the start stays under them.
      const wx = (s.mid.x - s.view.x) / s.view.k;
      const wy = (s.mid.y - s.view.y) / s.view.k;
      view = { k, x: mid.x - wx * k, y: mid.y - wy * k };
    }
    emit();
  }

  function onUp(e: PointerEvent) {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 0) dragging = false;
    rebaseline();  // 2 fingers -> 1: carry on panning from here, no jump
  }

  // Swallow the click that follows a drag so a pan doesn't open a person.
  function onClickCapture(e: MouseEvent) {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
  }

  // Trackpad pinch (ctrl+wheel) and mouse wheel on desktop.
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (e.ctrlKey || e.deltaMode === 1 || Math.abs(e.deltaY) > 50 && !e.deltaX) {
      const k = clamp(view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
      view = { k, x: p.x - ((p.x - view.x) / view.k) * k, y: p.y - ((p.y - view.y) / view.k) * k };
    } else {
      view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY };
    }
    emit();
  }

  // Old iOS Safari fires its own gesture events for pinch; block them here.
  const stopGesture = (e: Event) => e.preventDefault();

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("lostpointercapture", onUp as EventListener);
  el.addEventListener("click", onClickCapture, true);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("gesturestart", stopGesture);
  el.addEventListener("gesturechange", stopGesture);

  emit();

  return {
    get: () => ({ ...view }),
    set(v: View) { view = { ...v, k: clamp(v.k) }; rebaseline(); emit(); },
    destroy() {
      cancelAnimationFrame(frame);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("lostpointercapture", onUp as EventListener);
      el.removeEventListener("click", onClickCapture, true);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", stopGesture);
      el.removeEventListener("gesturechange", stopGesture);
    },
  };
}

// Only re-fit the tree when the width really changes (rotation, desktop
// window resize). The iPhone address bar sliding in and out changes only the
// height, and it was triggering the "zooms all the way out" snap.
export function onRealResize(cb: () => void) {
  let w = window.innerWidth;
  const handler = () => {
    if (Math.abs(window.innerWidth - w) < 2) return;
    w = window.innerWidth;
    cb();
  };
  window.addEventListener("resize", handler);
  return () => window.removeEventListener("resize", handler);
}
