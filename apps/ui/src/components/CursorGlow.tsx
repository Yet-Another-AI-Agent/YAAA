import { useEffect, useRef } from "react";

/**
 * CursorGlow
 * Renders a radial spotlight that follows the mouse — bright indigo/violet
 * at the cursor centre, fading to transparent at the radius edge.
 * Fully pointer-events: none so it never blocks clicks.
 */
export function CursorGlow() {
  const glowRef = useRef<HTMLDivElement>(null);
  const pos = useRef({ x: -9999, y: -9999 });
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const el = glowRef.current;
    if (!el) return;

    const onMove = (e: MouseEvent) => {
      pos.current = { x: e.clientX, y: e.clientY };
    };

    const tick = () => {
      if (el) {
        el.style.setProperty("--gx", `${pos.current.x}px`);
        el.style.setProperty("--gy", `${pos.current.y}px`);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return <div ref={glowRef} className="cursor-glow" aria-hidden="true" />;
}
