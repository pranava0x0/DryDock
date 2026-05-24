import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { BudgetWidget } from "@/components/BudgetWidget";

export const metadata: Metadata = {
  title: "DryDock",
  description: "Personal project orchestrator",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "DryDock",
  },
};

export const viewport: Viewport = {
  // viewportFit: "cover" lets the page extend behind the iPhone notch /
  // dynamic island; we rely on env(safe-area-inset-*) in globals.css to keep
  // tappable elements out of those zones.
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Matches the Kraken Deep Sea Blue background so the iOS status bar
  // blends into the page chrome when launched as a standalone PWA.
  themeColor: "#001628",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-kraken-deep text-zinc-50">
        <header className="sticky top-0 z-10 border-b border-kraken-boundless bg-kraken-deep/80 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
            <a
              href="/"
              className="flex items-center gap-2 text-lg font-semibold tracking-tight text-zinc-50"
            >
              {/* Anchor mark — see design.md for the Kraken/anchor motif rationale. */}
              <span aria-hidden="true" className="text-kraken-ice">⚓</span>
              DryDock
            </a>
            <div className="flex items-center gap-4">
              <nav className="flex items-center gap-4">
                <Link href="/backlog" className="text-sm text-kraken-shadow transition hover:text-kraken-ice">Backlog</Link>
                <Link href="/settings" className="text-sm text-kraken-shadow transition hover:text-kraken-ice">Budget</Link>
                <Link href="/analytics" className="text-sm text-kraken-shadow transition hover:text-kraken-ice">Analytics</Link>
              </nav>
              <BudgetWidget />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
