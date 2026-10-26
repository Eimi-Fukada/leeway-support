import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Leeway Support · 客服调试",
  icons: { icon: "data:," },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
