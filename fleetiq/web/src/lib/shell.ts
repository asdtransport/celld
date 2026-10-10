import { esc, gateOperatorControls, me } from "./api";

// Shell behaviour shared by every page: identity in the rail, mobile menu, drawers.
export function boot() {
  const btn = document.getElementById("menu-btn");
  btn?.addEventListener("click", () => {
    const open = document.body.dataset.nav !== "open";
    document.body.dataset.nav = open ? "open" : "";
    btn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.body.dataset.nav = ""; });
  document.addEventListener("click", (e) => {
    if (document.body.dataset.nav === "open" && !(e.target as HTMLElement).closest("#rail, #menu-btn")) document.body.dataset.nav = "";
  });

  me().then((m) => {
    const who = document.getElementById("whoami");
    if (who) who.innerHTML = `<strong>${esc(m.name ?? m.email ?? m.sub)}</strong>${m.authMode === "none" ? "No sign-in (trusted network)" : m.canOperate ? "Operator" : "Viewer — read only"}`;
    gateOperatorControls();
  }).catch(() => {});

  // [data-drawer-open="id"] opens <dialog id="id" class="drawer">; [data-drawer-close] closes it.
  document.querySelectorAll<HTMLElement>("[data-drawer-open]").forEach((el) =>
    el.addEventListener("click", () => (document.getElementById(el.dataset.drawerOpen!) as HTMLDialogElement)?.showModal()));
  document.querySelectorAll<HTMLElement>("[data-drawer-close]").forEach((el) =>
    el.addEventListener("click", () => (el.closest("dialog") as HTMLDialogElement)?.close()));
}
