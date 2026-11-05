import { useId } from "react";

export interface ControlSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange?: (v: number) => void;
  onInput?: (v: number) => void;
  display?: (v: number) => string;
  disabled?: boolean;
}

export function ControlSlider({ label, value, min, max, step, onChange, onInput, display, disabled }: ControlSliderProps) {
  const id = useId();
  const handler = onChange ?? onInput;
  const text = display ? display(value) : String(value);
  return (
    <div className={["flex flex-col gap-1.5", disabled ? "opacity-50" : ""].join(" ")}>
      <div className="flex justify-between items-baseline gap-2">
        <label htmlFor={id} className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </label>
        {display && (
          <output htmlFor={id} className="text-[11px] text-foreground/70 font-mono tabular-nums">{text}</output>
        )}
      </div>
      <div className="flex items-center h-6">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-valuetext={text}
          data-testid={`slider-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
          className="w-full h-1 accent-primary cursor-pointer disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          onChange={(e) => handler?.(Number(e.currentTarget.value))}
        />
      </div>
    </div>
  );
}

export default ControlSlider;
