import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
