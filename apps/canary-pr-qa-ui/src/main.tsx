import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Dashboard root container is missing");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
