import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LeadCall AI — SDR Platform",
  description: "AI-powered multi-agent SDR platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0a0a0f] text-gray-100 font-mono antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
