import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { startApp } from "./core/app";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

startApp();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
