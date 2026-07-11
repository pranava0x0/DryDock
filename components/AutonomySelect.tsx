"use client";

import type { AutonomyLevel } from "@/lib/providers/types";

const OPTIONS: Array<{
  value: AutonomyLevel;
  label: string;
  hint: string;
}> = [
  { value: "readonly", label: "Read-only", hint: "plan/analyze, no writes" },
  { value: "edits", label: "Edits", hint: "file edits + tests" },
  { value: "full", label: "Full", hint: "edits + any shell command" },
];

/**
 * Three-way agent blast-radius picker, shared by AddProjectModal and the
 * project page. Renders the selected option's hint underneath so the
 * consequence is visible before anything is dispatched.
 */
export function AutonomySelect({
  value,
  onChange,
  disabled = false,
}: {
  value: AutonomyLevel;
  onChange: (level: AutonomyLevel) => void;
  disabled?: boolean;
}) {
  const selected = OPTIONS.find((o) => o.value === value) ?? OPTIONS[1];
  return (
    <fieldset className="block text-sm">
      <legend className="text-zinc-300">Agent autonomy</legend>
      <div className="mt-1 flex gap-2">
        {OPTIONS.map((option) => {
          const isSelected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`flex-1 min-h-[44px] rounded-md border px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                isSelected
                  ? "border-kraken-ice bg-kraken-ice/10 text-kraken-ice"
                  : "border-kraken-boundless bg-kraken-deep text-zinc-300 hover:border-kraken-shadow"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <span className="mt-1 block text-xs text-zinc-500">{selected.hint}</span>
    </fieldset>
  );
}
