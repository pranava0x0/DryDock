import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Seattle Kraken-inspired palette. See design.md for usage rules.
        // `kraken-deep` is the page background; `kraken-ice` is the primary
        // accent (FAB, primary CTAs, focus ring).
        "kraken-deep": "#001628",
        "kraken-surface": "#062236",
        "kraken-boundless": "#355464",
        "kraken-shadow": "#688199",
        "kraken-ice": "#99D9D9",
        "kraken-alert": "#E9072B",
        // Provider brand colors are kept separate from the chrome palette.
        claude: "#8b5cf6",
        gemini: "#3b82f6",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
