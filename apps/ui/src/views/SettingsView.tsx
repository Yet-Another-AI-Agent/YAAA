import React from "react";
import { ApiKeyModal } from "../components/ApiKeyModal";
import { TaskModel } from "../models/TaskModel";

type ModelPreference = "sota" | "balanced" | "cost-effective";

const OPTIONS: Array<{ value: ModelPreference; label: string; model: string; description: string }> = [
  { value: "cost-effective", label: "Base", model: "Gemini 2.5 Pro Preview or best reachable equivalent", description: "Use Gemini 2.5 Pro for the base performance tier." },
  { value: "balanced", label: "Medium", model: "Gemini 3.1 Pro Preview or best reachable equivalent", description: "Use Gemini 3.1 Pro for the medium performance tier." },
  { value: "sota", label: "Full", model: "Claude Opus 5 or best reachable equivalent", description: "Use the strongest Claude reasoning tier for difficult work." },
];

export function SettingsView({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = React.useState<Awaited<ReturnType<typeof TaskModel.getSettings>> | null>(null);
  const [apiKeyOpen, setApiKeyOpen] = React.useState(false);
  const [profile, setProfile] = React.useState({ name: "", profession: "", description: "" });
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    TaskModel.getSettings().then((value) => {
      setSettings(value);
      setProfile({ name: value.name, profession: value.profession, description: value.description });
    }).catch(() => {});
  }, []);

  const preference = settings?.modelPreference ?? "balanced";
  const index = OPTIONS.findIndex((option) => option.value === preference);

  const selectPreference = async (value: ModelPreference) => {
    setSettings((current) => current ? { ...current, modelPreference: value } : current);
    await TaskModel.saveModelPreference(value);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    await TaskModel.saveOnboardingProfile(profile);
    setSettings((current) => current ? { ...current, ...profile } : current);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  if (apiKeyOpen) {
    return (
      <div className="settings-page">
        <ApiKeyModal
          overlay
          title="Change Mesh API key"
          description="The replacement key is stored locally in your YAAA configuration."
          onSaved={() => { setApiKeyOpen(false); setSettings((current) => current ? { ...current, hasApiKey: true } : current); }}
          onClose={() => setApiKeyOpen(false)}
          submitLabel="Save key"
        />
      </div>
    );
  }

  return (
    <main className="settings-page">
      <div className="settings-header">
        <button type="button" className="btn btn-secondary" onClick={onBack}>← Back to YAAA</button>
        <div>
          <h1>Settings</h1>
          <p>Personal details, billing access, and the model policy used by YAAA and its sub-agents.</p>
        </div>
      </div>

      <section className="settings-grid">
        <form className="glass-card settings-card" onSubmit={saveProfile}>
          <h2>Your details</h2>
          <p className="settings-muted">These are the details you provided during initial setup.</p>
          <label className="form-label" htmlFor="settings-name">Name</label>
          <input id="settings-name" className="task-input" value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} />
          <label className="form-label" htmlFor="settings-profession">Profession</label>
          <input id="settings-profession" className="task-input" value={profile.profession} onChange={(event) => setProfile({ ...profile, profession: event.target.value })} />
          <label className="form-label" htmlFor="settings-description">About you</label>
          <textarea id="settings-description" className="settings-textarea" value={profile.description} onChange={(event) => setProfile({ ...profile, description: event.target.value })} />
          <button type="submit" className="btn btn-primary">Save details</button>
        </form>

        <section className="glass-card settings-card">
          <h2>Mesh account</h2>
          <p className="settings-muted">Your API key is kept locally and never displayed in full.</p>
          <div className="settings-key-status"><span className={`settings-status-dot ${settings?.hasApiKey ? "active" : ""}`} />{settings?.hasApiKey ? "API key configured" : "No API key configured"}</div>
          <div className="settings-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setApiKeyOpen(true)}>Change API key</button>
            <button type="button" className="btn btn-secondary" onClick={() => void TaskModel.openExternal("https://app.meshapi.ai/billing")}>Top up Mesh account ↗</button>
          </div>
          <p className="settings-muted settings-small">Top-up opens the Mesh billing page in your browser.</p>
        </section>
      </section>

      <section className="glass-card settings-card settings-model-card">
        <div className="settings-model-heading">
          <div><h2>Model performance policy</h2><p className="settings-muted">YAAA will ask its model advisor to choose the best available model for each exact subtask, then apply this policy.</p></div>
          <strong>{OPTIONS[index]?.label ?? "Balanced"}</strong>
        </div>
        <input
          aria-label="Model performance policy"
          className="settings-range"
          type="range"
          min="0"
          max="2"
          step="1"
          value={Math.max(index, 0)}
          onChange={(event) => void selectPreference(OPTIONS[Number(event.target.value)].value)}
        />
        <div className="settings-range-labels">{OPTIONS.map((option) => <button key={option.value} type="button" className={option.value === preference ? "selected" : ""} onClick={() => void selectPreference(option.value)}>{option.label}</button>)}</div>
        <div className="settings-policy-detail"><strong>{OPTIONS[index]?.model}</strong><span>{OPTIONS[index]?.description}</span></div>
        {saved ? <div className="settings-saved" role="status">Settings saved</div> : null}
      </section>
    </main>
  );
}
