import type { Metadata } from "next";
import "./globals.css";
import RumProvider from "@/components/RumProvider";

export const metadata: Metadata = {
  title: "StreamPay — streaming payments on Stellar",
  description:
    "Create, withdraw, top up and cancel continuous per-second payment streams on the Stellar network.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <RumProvider />
      </body>
    </html>
  );
}
