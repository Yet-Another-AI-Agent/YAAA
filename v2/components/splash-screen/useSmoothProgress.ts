import { useEffect, useRef, useState } from "react";

const clamp = (value: number) => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));

export function useSmoothProgress(target: number) {
  const targetRef = useRef(clamp(target));
  const [value, setValue] = useState(targetRef.current);
  const frame = useRef<number | null>(null);
  targetRef.current = clamp(target);

  useEffect(() => {
    const animate = () => {
      setValue((current) => {
        const difference = targetRef.current - current;
        if (Math.abs(difference) < 0.1) {
          if (frame.current !== null) cancelAnimationFrame(frame.current);
          frame.current = null;
          return targetRef.current;
        }
        frame.current = requestAnimationFrame(animate);
        return current + difference * 0.16;
      });
    };
    frame.current = requestAnimationFrame(animate);
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  }, [target]);
  return value;
}
