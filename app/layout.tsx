import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deedlords",
  description: "A property game whose rules, dice and stakes live in a NEAR contract. Buy the world's priciest cities, collect rent, win the pot.",
};

export const viewport: Viewport = {
  themeColor: "#14101f",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
