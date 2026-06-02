import React from "react";
import { createRoot } from "react-dom/client";
import App from "../../NoteSheetGenerator.jsx";

/*
 * Android entry point. The device-side concerns (storage shim, API-key
 * handling, demo fallback, settings UI) are set up in wrapper.js which runs
 * BEFORE this bundle. Here we simply mount the unmodified artifact component.
 */
createRoot(document.getElementById("root")).render(React.createElement(App));
