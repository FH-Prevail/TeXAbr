import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { installShim } from "./shim/electron-api";
import "./styles/global.css";
import "./styles/auth-admin.css";

// Install the window.api shim before any component mounts so that any imported
// module that touches window.api during init has it available.
installShim();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
