import { createRoot, type Root } from "react-dom/client";
import { StudentRegistrationSection } from "./components/landing/StudentRegistrationSection";

let root: Root | null = null;
let mountNode: HTMLDivElement | null = null;
let lastPath = "";

function remove() {
  root?.unmount();
  root = null;
  mountNode?.remove();
  mountNode = null;
}

function mount() {
  if (window.location.pathname !== "/") { remove(); return; }
  const footer = document.querySelector("footer.landing-footer");
  if (!footer) return;
  if (mountNode?.isConnected) return;

  mountNode = document.createElement("div");
  mountNode.id = "autoai-student-registration-mount";
  footer.parentElement?.insertBefore(mountNode, footer);
  root = createRoot(mountNode);
  root.render(<StudentRegistrationSection />);
}

function sync() {
  const path = window.location.pathname;
  if (path !== lastPath) { lastPath = path; remove(); }
  mount();
}

const observer = new MutationObserver(sync);
observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
window.setInterval(sync, 500);
sync();
