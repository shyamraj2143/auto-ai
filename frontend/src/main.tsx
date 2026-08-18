import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/index.css";
import "./styles/prism.css";
import "./styles/workspaceSurfaces.css";
import "./styles/responseCardOverrides.css";
import "./styles/featureFixes.css";
import "./styles/runtimeStabilityFixes.css";
import "./styles/simpleDesign.css";
import "./styles/nvidiaIntelligenceComposer.css";
import "./styles/modelActivityVisibilityFix.css";
import "./styles/callsContactsFixes.css";
import App from "./App";
import { beginStartupRecovery } from "./reliability/safeMode";
import { installFunctionalDialogDiagnostics, installResponsiveDiagnostics } from "./reliability/responsiveDiagnostics";

beginStartupRecovery();
document.documentElement.dataset.autoAiUi = "simple";
installResponsiveDiagnostics();
installFunctionalDialogDiagnostics();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
