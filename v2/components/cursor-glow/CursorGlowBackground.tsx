import React, { useEffect, useRef } from "react";
import "./cursor-glow.css";

export interface CursorGlowBackgroundProps { className?: string; }

export function CursorGlowBackground({ className = "" }: CursorGlowBackgroundProps) {
  const glowRef = useRef<HTMLDivElement>(null);
  const position = useRef({ x: -9999, y: -9999 });
  const frame = useRef<number>(0);

  useEffect(() => {
    const element = glowRef.current;
    if (!element) return;
    const onPointerMove = (event: PointerEvent) => { position.current = { x: event.clientX, y: event.clientY }; };
    const tick = () => {
      element.style.setProperty("--v2-glow-x", `${position.current.x}px`);
      element.style.setProperty("--v2-glow-y", `${position.current.y}px`);
      frame.current = window.requestAnimationFrame(tick);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    frame.current = window.requestAnimationFrame(tick);
    return () => { window.removeEventListener("pointermove", onPointerMove); window.cancelAnimationFrame(frame.current); };
  }, []);

  return <div ref={glowRef} className={`v2-cursor-glow ${className}`} aria-hidden="true" />;
}

