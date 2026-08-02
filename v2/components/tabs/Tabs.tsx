import React from "react";
import type { TabsProps } from "./interfaces/tabs.interfaces";
import "./tabs.css";

export function Tabs<T extends string>({ tabs, value, onChange, ariaLabel = "Tabs", className = "" }: TabsProps<T>) {
  return <div className={`v2-tabs ${className}`} role="tablist" aria-label={ariaLabel}>
    {tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={value === tab.id} onClick={() => onChange(tab.id)}>{tab.label}{typeof tab.count === "number" && <span>{tab.count}</span>}</button>)}
  </div>;
}

