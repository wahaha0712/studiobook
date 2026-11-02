/**
 * Appointment 宽松类型：由于数据库 appointments 表结构未知，
 * 使用 Record 作为基底，列出一些常见字段仅作可选提示。
 */
export type Appointment = Record<string, unknown> & {
  id?: string | number;
  name?: string;
  title?: string;
  customer?: string;
  date?: string;
  time?: string;
  appointment_at?: string;
  status?: string;
  notes?: string;
  created_at?: string;
  updated_at?: string;
};

/** 通用的 PostgREST / Supabase 返回错误 */
export interface SupabaseQueryError {
  message: string;
  code?: string;
  details?: unknown;
  hint?: string;
}
