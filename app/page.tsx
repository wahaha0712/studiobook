import { redirect } from 'next/navigation';

/**
 * 根页面直接重定向到预约列表。
 * 客户端会在 appointments/page 中再校验 session，
 * 未登录时自动跳到 /login。
 */
export default function HomePage() {
  redirect('/appointments');
}
