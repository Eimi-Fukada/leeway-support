import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./detail.css";
import "./documents.css";

export const metadata: Metadata = { title: "Leeway · 知识空间", description: "把散落的资料，收进有序的知识空间。", icons: { icon: "/brand-icon.svg", apple: "/brand-icon.png" } };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
