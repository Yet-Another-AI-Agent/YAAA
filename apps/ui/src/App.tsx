import { useState } from "react";
import { SplashView } from "./views/SplashView";
import { DashboardView } from "./views/DashboardView";
import { useTaskViewModel } from "./viewmodels/useTaskViewModel";
import { CursorGlow } from "./components/CursorGlow";
import { SettingsView } from "./views/SettingsView";

export default function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const viewModel = useTaskViewModel();

  return (
    <>
      <CursorGlow />
      {showSplash
        ? <SplashView onAnimationEnd={() => setShowSplash(false)} />
        : showSettings
          ? <SettingsView onBack={() => setShowSettings(false)} />
          : <DashboardView viewModel={viewModel} onOpenSettings={() => setShowSettings(true)} />
      }
    </>
  );
}
