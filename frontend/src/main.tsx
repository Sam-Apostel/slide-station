import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { standalone } from "./lib/api";
import "./index.css";
import "./theme.css"; // Slide Station skin; must load after the ProUI theme

const root = createRoot(document.getElementById("root")!);

if (standalone) {
  // the browser version finds its library first (loaded lazily, so the server build stays lean)
  import("@/standalone/boot").then(({ LibraryGate }) =>
    root.render(
      <StrictMode>
        <LibraryGate>
          <App />
        </LibraryGate>
      </StrictMode>,
    ),
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
