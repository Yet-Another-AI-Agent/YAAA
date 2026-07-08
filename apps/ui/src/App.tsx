import { useState } from "react";
import { SplashView } from "./views/SplashView";
import { DashboardView } from "./views/DashboardView";
import { useTaskViewModel } from "./viewmodels/useTaskViewModel";
import { CursorGlow } from "./components/CursorGlow";

export default function App() {
  const [showSplash, setShowSplash] = useState(true);
  const viewModel = useTaskViewModel();

  return (
    <>
      <CursorGlow />
      {showSplash
        ? <SplashView onAnimationEnd={() => setShowSplash(false)} />
        : <DashboardView viewModel={viewModel} />
      }
    </>
  );
}
