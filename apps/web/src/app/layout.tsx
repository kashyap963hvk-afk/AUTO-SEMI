import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Devin AI for VLSI",
  description: "Describe the chip you need in plain English. Get a reviewed spec, verified RTL, real tool evidence and a release package for expert review.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
      </head>
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="brand-mark">AI</span>
            <span>
              Devin AI for VLSI <small>· digital ASIC assistant</small>
            </span>
          </Link>
          <nav className="nav">
            <Link href="/">Projects</Link>
            <Link href="/settings">Tools &amp; AI</Link>
            <a href="https://github.com/kashyap963hvk-afk/auto-vlsi" target="_blank" rel="noreferrer">
              Source
            </a>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
