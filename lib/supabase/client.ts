import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url) {
  throw new Error(
    '[Supabase] 缺少 NEXT_PUBLIC_SUPABASE_URL 环境变量，请在项目根目录的 .env.local 中配置。'
  );
}
if (!anonKey) {
  throw new Error(
    '[Supabase] 缺少 NEXT_PUBLIC_SUPABASE_ANON_KEY 环境变量，请在项目根目录的 .env.local 中配置。'
  );
}

/**
 * 浏览器端 Supabase 客户端单例。
 * 仅在客户端组件（'use client'）中使用。
 */
export const supabase = createClient(url, anonKey);
