import type { TaskStatus } from "@/lib/db/tasks";

// Status → visual treatment. Kept as a const map (rather than scattered
// ternaries) so the design system stays in one place.
const STYLES: Record<TaskStatus, string> = {
  pending: "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30",
  claimed: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  running: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  done: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  failed: "bg-kraken-alert/15 text-kraken-alert ring-kraken-alert/40",
};

const LABELS: Record<TaskStatus, string> = {
  pending: "Pending",
  claimed: "Claimed",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STYLES[status]}`}
    >
      {LABELS[status]}
    </span>
  );
}
