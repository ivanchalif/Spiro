import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface SimulationLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
}

export function SimulationLayout({ sidebar, children }: SimulationLayoutProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); toggleRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onMq = () => { if (mq.matches) setOpen(false); };
    mq.addEventListener("change", onMq);
    return () => mq.removeEventListener("change", onMq);
  }, []);

  return (
    <div className="flex flex-col md:flex-row h-[100dvh] w-full overflow-hidden bg-background">
      {/* Mobile top bar */}
      <div className="md:hidden flex items-center justify-between gap-2 px-3 h-12 shrink-0 border-b border-border bg-card">
        <span className="text-xs font-semibold tracking-tight">Spirograph NCG</span>
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          data-testid="button-toggle-controls"
          className="h-9 px-3 rounded-lg text-xs font-semibold border border-primary/25 bg-primary/10 text-primary hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {open ? "Hide controls" : "Show controls"}
        </button>
      </div>

      {open && (
        <div
          className="md:hidden fixed inset-0 top-12 z-30 bg-black/50"
          aria-hidden="true"
          onClick={() => { setOpen(false); toggleRef.current?.focus(); }}
        />
      )}

      <aside
        id={panelId}
        ref={panelRef}
        tabIndex={-1}
        aria-label="Simulation controls"
        className={[
          "simulation-controls flex flex-col bg-card border-border overflow-y-auto overscroll-contain outline-none",
          "md:static md:flex md:w-[280px] md:shrink-0 md:border-r md:h-full md:max-h-none md:shadow-none",
          open
            ? "fixed left-0 right-0 top-12 z-40 max-h-[calc(100dvh-3rem-1rem)] border-b shadow-2xl rounded-b-2xl"
            : "hidden",
        ].join(" ")}
      >
        {sidebar}
      </aside>

      <main className="relative flex-1 min-w-0 min-h-0 flex items-center justify-center overflow-hidden">
        {children}
      </main>
    </div>
  );
}

export default SimulationLayout;
