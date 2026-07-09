import React from "react";
import { TaskModel } from "../models/TaskModel";
import { isValidMeshApiKey } from "../utils/validation";

interface ApiKeyModalProps {
  /** Heading shown at the top of the card. */
  title?: string;
  /** Sub-heading / explanation shown under the title. */
  description?: string;
  /** Optional highlighted notice (e.g. add-funds instructions). */
  notice?: React.ReactNode;
  /** Called after the key has been persisted successfully. */
  onSaved: () => void;
  /** If provided, renders a dismiss button and enables the overlay backdrop. */
  onClose?: () => void;
  /** Render centered over the app (dashboard) rather than inline (splash). */
  overlay?: boolean;
  /** Text for the primary submit button. */
  submitLabel?: string;
}

/**
 * The Mesh API-key entry card. Shared between onboarding (SplashView step-a)
 * and the out-of-funds prompt (DashboardView overlay) so both look identical.
 */
export function ApiKeyModal({
  title = "Mesh API Key Configuration",
  description = "To start running agentic workflows, please configure your Mesh API Key. This will be stored locally in config.json.",
  notice,
  onSaved,
  onClose,
  overlay = false,
  submitLabel = "Save & Continue",
}: ApiKeyModalProps) {
  const [apiKey, setApiKey] = React.useState("");
  const [apiKeyError, setApiKeyError] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      setApiKeyError("Mesh API Key cannot be empty.");
      return;
    }
    if (!isValidMeshApiKey(apiKey)) {
      setApiKeyError("Please enter a valid Mesh API Key (at least 8 characters, no spaces).");
      return;
    }
    setApiKeyError("");
    setSaving(true);
    try {
      await TaskModel.saveOnboardingKeys(apiKey.trim());
      onSaved();
    } catch (err) {
      console.error("Failed to save key:", err);
      setApiKeyError("Failed to save API key. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const card = (
    <div className="glass-card onboarding-container">
      <h2 className="onboarding-title">{title}</h2>
      <p className="onboarding-desc">{description}</p>
      {notice && <div className="api-key-notice">{notice}</div>}
      <form onSubmit={handleSave} className="onboarding-form">
        <div className="form-group">
          <label className="form-label" htmlFor="mesh-api-key">
            Mesh API Access Key
          </label>
          <input
            id="mesh-api-key"
            type="password"
            className="task-input"
            placeholder="Enter your Mesh API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoFocus
          />
          {apiKeyError && <div className="error-message">{apiKeyError}</div>}
        </div>
        <div className="onboarding-actions">
          {onClose && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={saving}
            >
              Close
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving..." : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );

  if (overlay) {
    return <div className="modal-overlay">{card}</div>;
  }
  return card;
}
