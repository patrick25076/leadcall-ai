import type { Metadata } from "next";
import "./globals.css";
import { AnalyticsProvider } from "@/components/AnalyticsProvider";

export const metadata: Metadata = {
  title: "GRAI — The Voice of Your Business",
  description: "AI-powered outreach platform. Find leads, craft pitches, make calls — automatically.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0a0a0f] text-gray-100 font-sans antialiased min-h-screen">
        <AnalyticsProvider />
        {children}
      </body>
    </html>
  );
}
