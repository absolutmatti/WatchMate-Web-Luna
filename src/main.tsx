import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root-Element #root wurde nicht gefunden.");
}

createRoot(rootElement).render(<App />);