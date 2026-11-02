import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Studiobook · 预约管理',
  description: '基于 Next.js 14 + Supabase 的预约管理前端',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
