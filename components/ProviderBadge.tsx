import type { ProviderName } from "@/lib/providers";

const STYLES: Record<ProviderName, string> = {
  // Tailwind opacity utilities give a softer "pill" look than full saturation.
  claude: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  gemini: "bg-blue-500/15 text-blue-300 ring-blue-500/30",
};

const LABELS: Record<ProviderName, string> = {
  claude: "Claude",
  gemini: "Gemini",
};

export function ProviderBadge({ provider }: { provider: ProviderName }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STYLES[provider]}`}
    >
      {LABELS[provider]}
    </span>
  );
}
