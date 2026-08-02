import React, { useEffect, useRef } from "react";
import logoImg from "./assets/logo.jpg";
import type { SplashScreenProps } from "./interfaces/splash-screen.interfaces";
import { useSmoothProgress } from "./useSmoothProgress";
import "./splash-screen.css";
import "./splash-screen-failed.css";

export function SplashScreen({ title = "YAAA", progress = 0, message = "Initializing agent runtime...", errorMessage = "Failed to load workspace.", status = "loading", loaded = false, className = "", onSuccess, onEvent }: SplashScreenProps) {
  const effectiveStatus = loaded ? "success" : status;
  const effectiveProgress = effectiveStatus === "success" || effectiveStatus === "failed" ? 100 : progress;
  const displayedProgress = useSmoothProgress(effectiveProgress);
  const emittedSuccess = useRef(false);
  const emittedFailure = useRef<string | undefined>(undefined);
  const navigatedHome = useRef(false);
  useEffect(() => {
    if (effectiveStatus === "success" && !emittedSuccess.current) {
      emittedSuccess.current = true;
      onEvent?.({ kind: "loaded-success" });
    }
    if (effectiveStatus !== "success") emittedSuccess.current = false;
    if (effectiveStatus === "failed" && errorMessage && emittedFailure.current !== errorMessage) {
      emittedFailure.current = errorMessage;
      onEvent?.({ kind: "failed", message: errorMessage });
    }
    if (effectiveStatus !== "failed") emittedFailure.current = undefined;
  }, [effectiveStatus, errorMessage, onEvent]);
  useEffect(() => {
    if (effectiveStatus === "success" && !navigatedHome.current) { navigatedHome.current = true; onSuccess?.(); }
    if (effectiveStatus !== "success") navigatedHome.current = false;
  }, [effectiveStatus, onSuccess]);
  return <main className={`v2-splash-screen is-${effectiveStatus} ${className}`} aria-label="Splash screen" aria-busy={effectiveStatus === "loading"}><div className="v2-splash-glow" aria-hidden="true" /><div className="v2-splash-content"><img src={logoImg} className="v2-splash-app-logo" alt={`${title} Logo`} /><p className="v2-splash-subtitle">Yet Another AI Agent</p><div className="v2-splash-loader" role="progressbar" aria-label="Loading progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(displayedProgress)}><span style={{ width: `${displayedProgress}%` }} /></div><div className="v2-splash-status">{effectiveStatus === "failed" ? errorMessage : message}</div></div></main>;
}
