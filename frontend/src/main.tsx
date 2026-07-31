import React from "react";
import ReactDOM from "react-dom/client";
import "highlight.js/styles/github-dark.min.css";
import "./styles/index.css";
import "./styles/crystal.css";
import "./styles/prism.css";
import "./styles/actionHubTheme.css";
import "./styles/workspaceSurfaces.css";
import "./styles/responseCardOverrides.css";
import "./styles/brandingOverrides.css";
import App from "./App";
import { beginStartupRecovery } from "./reliability/safeMode";
import { installFunctionalDialogDiagnostics, installResponsiveDiagnostics } from "./reliability/responsiveDiagnostics";

beginStartupRecovery();
installResponsiveDiagnostics();
installFunctionalDialogDiagnostics();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
