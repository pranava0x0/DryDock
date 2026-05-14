// Tech-stack chip used on the discover page. Tiny by design — there can
// be 50+ chips on one page so we want them light.
const STYLES: Record<string, string> = {
  next: "bg-zinc-100/10 text-zinc-100 ring-zinc-100/30",
  node: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  vite: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  pnpm: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  python: "bg-blue-500/15 text-blue-300 ring-blue-500/30",
  rust: "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  go: "bg-cyan-500/15 text-cyan-300 ring-cyan-500/30",
  ruby: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  php: "bg-indigo-500/15 text-indigo-300 ring-indigo-500/30",
};

export function StackChip({ label }: { label: string }) {
  const style = STYLES[label] ?? "bg-kraken-boundless/30 text-zinc-300 ring-kraken-boundless";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}
    >
      {label}
    </span>
  );
}
