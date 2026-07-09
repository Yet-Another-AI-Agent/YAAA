import React from "react";
import logoImg from "../assets/logo.jpg";
import { TaskModel } from "../models/TaskModel";

interface SplashViewProps {
  onAnimationEnd: () => void;
}

export function SplashView({ onAnimationEnd }: SplashViewProps) {
  const [step, setStep] = React.useState<"splash" | "step-a" | "step-b">(
    "splash",
  );

  // Form states
  const [apiKey, setApiKey] = React.useState("");
  const [apiKeyError, setApiKeyError] = React.useState("");
  const [name, setName] = React.useState("");
  const [profession, setProfession] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [isParsing, setIsParsing] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    let timerEnded = false;
    let fetchedStatus: any = null;

    const timer = setTimeout(() => {
      if (active) {
        timerEnded = true;
        checkTransition();
      }
    }, 3000);

    if (!(window as any).electronAPI) {
      fetchedStatus = { hasKey: true, hasProfile: true, skipped: true };
      checkTransition();
    } else {
      TaskModel.getOnboardingStatus()
        .then((s) => {
          if (active) {
            fetchedStatus = s;
            checkTransition();
          }
        })
        .catch((err) => {
          console.error("Failed to check onboarding status:", err);
          if (active) {
            fetchedStatus = { hasKey: true, hasProfile: true, skipped: true };
            checkTransition();
          }
        });
    }

    function checkTransition() {
      if (active && timerEnded && fetchedStatus) {
        if (
          fetchedStatus.hasKey &&
          (fetchedStatus.hasProfile || fetchedStatus.skipped)
        ) {
          onAnimationEnd();
        } else if (!fetchedStatus.hasKey) {
          setStep("step-a");
        } else {
          setStep("step-b");
        }
      }
    }

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [onAnimationEnd]);

  const handleSaveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      setApiKeyError("Mesh API Key cannot be empty.");
      return;
    }
    setApiKeyError("");
    try {
      await TaskModel.saveOnboardingKeys(apiKey.trim());
      const newStatus = await TaskModel.getOnboardingStatus();
      if (!newStatus.hasProfile && !newStatus.skipped) {
        setStep("step-b");
      } else {
        onAnimationEnd();
      }
    } catch (err) {
      console.error("Failed to save key:", err);
      setApiKeyError("Failed to save API key. Please try again.");
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await TaskModel.saveOnboardingProfile({
        name: name.trim(),
        profession: profession.trim(),
        description: description.trim(),
        skip: false,
      });
      onAnimationEnd();
    } catch (err) {
      console.error("Failed to save profile:", err);
    }
  };

  const handleSkipProfile = async () => {
    try {
      await TaskModel.saveOnboardingProfile({
        skip: true,
      });
      onAnimationEnd();
    } catch (err) {
      console.error("Failed to skip profile:", err);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      const text = evt.target?.result as string;
      if (!text) return;

      try {
        setIsParsing(true);
        const parsed = await TaskModel.parseResume(text);
        if (parsed) {
          if (parsed.name) setName(parsed.name);
          if (parsed.profession) setProfession(parsed.profession);
          if (parsed.description) setDescription(parsed.description);
        }
      } catch (err) {
        console.error("Failed to parse resume file:", err);
      } finally {
        setIsParsing(false);
      }
    };
    reader.readAsText(file);
  };

  if (step === "splash") {
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

  if (step === "step-a") {
    return (
      <div className="splash-container">
        <div className="splash-glow" />
        <div className="glass-card onboarding-container">
          <h2 className="onboarding-title">Mesh API Key Configuration</h2>
          <p className="onboarding-desc">
            To start running agentic workflows, please configure your Mesh API
            Key. This will be stored locally in config.json.
          </p>
          <form onSubmit={handleSaveKey} className="onboarding-form">
            <div className="form-group">
              <label className="form-label" htmlFor="mesh-api-key">Mesh API Access Key</label>
              <input
                id="mesh-api-key"
                type="password"
                className="task-input"
                placeholder="Enter Mesh API Key (e.g. mesh_...)"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoFocus
              />
              {apiKeyError && (
                <div className="error-message">{apiKeyError}</div>
              )}
            </div>
            <div className="onboarding-actions">
              <button type="submit" className="btn-primary">
                Save & Continue
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // step === "step-b"
  return (
    <div className="splash-container">
      <div className="splash-glow" />
      <div
        className="glass-card onboarding-container"
        style={{ maxHeight: "90vh", overflowY: "auto" }}
      >
        <h2 className="onboarding-title">Create Agentic Profile</h2>
        <p className="onboarding-desc">
          Help the AI agent adapt to your professional style, preferences, and
          guidelines. Upload your resume or fill out the profile.
        </p>
        <form onSubmit={handleSaveProfile} className="onboarding-form">
          <div className="file-upload-zone">
            <input
              type="file"
              accept=".txt"
              onChange={handleFileUpload}
              disabled={isParsing}
            />
            <div className="file-upload-text">
              {isParsing
                ? "Parsing Resume via CLI..."
                : "Drag & Drop or Click to Upload Resume (.txt)"}
            </div>
            <div className="file-upload-hint">
              Extracts your details using the Mesh Gateway.
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="user-name">Full Name</label>
            <input
              id="user-name"
              type="text"
              className="task-input"
              placeholder="e.g. Alice Smith"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="user-profession">Profession</label>
            <input
              id="user-profession"
              type="text"
              className="task-input"
              placeholder="e.g. Principal Software Engineer"
              value={profession}
              onChange={(e) => setProfession(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="user-bio">Biography / Guidelines</label>
            <textarea
              id="user-bio"
              className="task-input onboarding-textarea"
              placeholder="Describe your background, skills, and coding preferences."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </div>

          <div className="onboarding-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={handleSkipProfile}
              disabled={isParsing}
            >
              Skip Profile
            </button>
            <button type="submit" className="btn-primary" disabled={isParsing}>
              Save & Finish
            </button>
          </div>
        </form>

        <div className="guide-section">
          <h4 className="guide-title">How to Export Profiles</h4>
          <div className="guide-grid">
            <div className="guide-card">
              <div className="guide-card-brand chatgpt">ChatGPT</div>
              <div className="guide-card-text">
                Go to Settings &gt; Personalization &gt; Custom Instructions or
                Memory to copy your profile details.
              </div>
            </div>
            <div className="guide-card">
              <div className="guide-card-brand claude">Claude</div>
              <div className="guide-card-text">
                Go to Settings &gt; Custom Instructions or copy instructions
                from your developer profile settings.
              </div>
            </div>
            <div className="guide-card">
              <div className="guide-card-brand gemini">Gemini</div>
              <div className="guide-card-text">
                Go to Gemini Settings &gt; Gemini Apps Activity or copy your
                saved context from your profile.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
