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
        {/*
          The waterline. A dry dock is a basin the water is pumped out of,
          and the whole palette already reads as "port at night" — this
          gives the page an actual horizon to sit against instead of a
          flat wash: a faint band of light where the surface would be,
          fading into deeper water further down. Fixed and
          pointer-events-none, so it costs one composited layer and
          intercepts nothing. Purely atmospheric; nothing is legible only
          because of it.
        */}
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-0 bg-[radial-gradient(120%_60%_at_50%_-10%,rgba(153,217,217,0.07),transparent_60%),linear-gradient(to_bottom,transparent_0%,rgba(0,10,20,0.35)_55%,rgba(0,8,16,0.6)_100%)]"
        />

        <header className="sticky top-0 z-20 border-b border-kraken-boundless bg-kraken-deep/85 backdrop-blur">
          {/* Gantry rail: the crane track that runs the length of a dock.
              A 1px gradient, brightest at the centre. */}
          <div
            aria-hidden="true"
            className="h-px w-full bg-gradient-to-r from-transparent via-kraken-ice/30 to-transparent"
          />
          {/*
            One row, and it has to fit 375px. The original measured 416px
            of content there — the budget pill was clipped clean off the
            right edge on the primary target viewport — and the bare text
            links had no min-height, so they failed the 44px touch floor
            too. The fix isn't a second row (a 220px sticky header eats a
            quarter of a phone screen forever); it's dropping the
            "DryDock" wordmark below `sm`, where the anchor alone carries
            the brand and the app's name is already on the home-screen
            icon and the tab title.
          */}
          <div className="mx-auto flex max-w-5xl items-center gap-1 px-4 py-1.5 sm:gap-3 xl:max-w-[88rem]">
            <a
              href="/"
              aria-label="DryDock home"
              className="flex min-h-[44px] shrink-0 items-center gap-2 pr-1 text-lg font-semibold tracking-tight text-zinc-50"
            >
              {/* Anchor mark — see design.md for the anchor/crane motif. */}
              <span aria-hidden="true" className="text-kraken-ice">
                ⚓
              </span>
              <span className="hidden sm:inline">DryDock</span>
            </a>
            <nav className="flex min-w-0 items-center gap-0.5 sm:gap-2">
              {[
                { href: "/backlog", label: "Backlog" },
                { href: "/settings", label: "Budget" },
                { href: "/analytics", label: "Analytics" },
              ].map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="inline-flex min-h-[44px] items-center rounded-md px-1.5 text-xs text-kraken-shadow transition hover:bg-kraken-boundless/30 hover:text-kraken-ice sm:px-2 sm:text-sm"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto shrink-0">
              <BudgetWidget />
            </div>
          </div>
        </header>
        {/* max-w-5xl (1024px) was right when every page was one column. With
            a side rail on /backlog and three-wide cards on Usage, a 1600px
            display was mostly gutter — so the container widens at `xl`.
            It does NOT go full-bleed: past ~1400px, line length starts
            hurting readability more than the extra width helps. */}
        <main className="relative z-10 mx-auto max-w-5xl px-4 py-6 xl:max-w-[88rem]">
          {children}
        </main>
      </body>
    </html>
  );
}
