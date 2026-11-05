interface Props {
  playing: boolean; canUndo: boolean; canRedo: boolean; hasDrawing: boolean; hasSaved: boolean;
  onUndo: () => void; onRedo: () => void; onSave: () => void; onRestore: () => void;
  onExport: () => void; onNew: () => void; notice: string;
}

export function DrawingActions(p: Props) {
  const button = "min-h-10 rounded-lg border border-border px-2 text-xs font-medium hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40 disabled:cursor-not-allowed";
  return (
    <section aria-label="Drawing history and files" className="flex flex-col gap-2 border-t border-border px-3 py-3">
      <p className="text-xs font-semibold text-foreground">Drawing history & files</p>
      <div className="grid grid-cols-2 gap-2">
        <button className={button} disabled={p.playing || !p.canUndo} onClick={p.onUndo}>Undo stroke</button>
        <button className={button} disabled={p.playing || !p.canRedo} onClick={p.onRedo}>Redo stroke</button>
        <button className={button} disabled={p.playing} onClick={p.onNew}>New stroke</button>
        <button className={button} disabled={!p.hasDrawing} onClick={p.onExport}>Export PNG</button>
        <button className={button} disabled={p.playing} onClick={p.onSave} title="Replaces the saved drawing in this browser">Save locally</button>
        <button className={button} disabled={p.playing || !p.hasSaved} onClick={p.onRestore}>Restore saved</button>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Pause to edit. New stroke keeps existing artwork. Local saves stay in this browser.
        Older strokes are flattened during long sessions; undo applies to recent strokes.
      </p>
      <p role="status" aria-live="polite" className="text-xs leading-relaxed text-primary min-h-4">{p.notice}</p>
    </section>
  );
}
