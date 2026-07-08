import React from "react";
import logoImg from "../assets/logo.jpg";

interface SplashViewProps {
  onAnimationEnd: () => void;
}

export function SplashView({ onAnimationEnd }: SplashViewProps) {
  React.useEffect(() => {
    const timer = setTimeout(() => {
      onAnimationEnd();
    }, 3000);
    return () => clearTimeout(timer);
  }, [onAnimationEnd]);

  return (
    <div className="splash-container">
      <div className="splash-glow" />
      <div className="splash-content">
        <img src={logoImg} className="splash-app-logo" alt="YAAA Logo" />
        <p className="splash-subtitle">Yet Another AI Agent</p>
        <div className="splash-loader-bar">
          <div className="splash-loader-progress" />
        </div>
        <div className="splash-status">Initializing CLI Native Runner...</div>
      </div>
    </div>
  );
}
