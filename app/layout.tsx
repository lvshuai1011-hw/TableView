import type { Metadata } from "next";
import "./globals.css";
import "./claude-assistant.css";
import { ClaudeAssistantHost } from "./claude-assistant-host";

export const metadata: Metadata = {
  title: "Schema Atlas · 表关系探索器",
  description: "批量导入 PDM JSON，从业务域逐层下钻到表、外键与字段映射。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}<ClaudeAssistantHost /></body></html>;
}
