'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import type { Appointment, SupabaseQueryError } from '@/lib/types';

/* ------------------------------------------------------------------ */
/* 字段展示工具                                                        */
/* ------------------------------------------------------------------ */

/** 永远不在列表里展示的技术字段 */
const HIDDEN_KEYS = new Set(['id', 'user_id', 'tsv', 'search_vector']);

/** 判断是否技术字段（过滤 id / user_id / 任意 *_id） */
function isHiddenField(key: string): boolean {
  if (HIDDEN_KEYS.has(key.toLowerCase())) return true;
  if (/_id$/i.test(key)) return true;
  return false;
}

/** 尝试当作时间字符串格式化，失败则原样返回 */
function formatDateLike(value: unknown): string {
  if (value == null) return '';
  const str = String(value);
  const maybeDate = new Date(str);
  if (!isNaN(maybeDate.getTime()) && /\d{4}-\d{2}-\d{2}/.test(str)) {
    return maybeDate.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return str;
}

/** 字段名是否像时间 */
function looksLikeDateField(key: string): boolean {
  return /(date|time|at|created|updated|timestamp)$/i.test(key);
}

/* ------------------------------------------------------------------ */
/* 表单语义字段 → 数据库列名映射                                        */
/* ------------------------------------------------------------------ */

/**
 * 拿到真实列名后只改这里：
 * 左边是表单语义 key（不要改），右边是数据库列名（按探测/信息模式结果改）。
 *
 * 当前值来自实测探测（GET ?select=<col>&limit=1 返回 200 即存在）：
 *   client_name        ✅ 存在，且为 NOT NULL（必填）
 *   appointment_time   ✅ 存在
 *   status             ✅ 存在
 *   notes              ✅ 存在
 *   shoot_type         ✅ 存在，NOT NULL（前端语义为「服务项目」，列名保持不变）
 *   （title / appointment_at / updated_at 均已实测不存在）
 */
const COLUMN_MAP = {
  title: 'client_name',
  service: 'shoot_type',
  scheduledAt: 'appointment_time',
  status: 'status',
  notes: 'notes',
} as const;

/** 时间列是否已确认。未确认时表单可以填，但不写入数据库 */
const TIME_COLUMN_CONFIRMED = true;

/** 服务项目是否确认可写（该列存在且必填，故为 true） */
const SERVICE_COLUMN_CONFIRMED = true;

/** 「服务项目」下拉选项（与数据库列 shoot_type 的取值需匹配约束） */
const SERVICE_OPTIONS = ['基础服务', '进阶服务', '深度护理', '其他'] as const;
const DEFAULT_SERVICE: string = SERVICE_OPTIONS[0];

type SemanticKey = keyof typeof COLUMN_MAP;

/** 语义字段的中文名，用于「已跳过不存在的列」提示 */
const SEMANTIC_LABELS: Record<SemanticKey, string> = {
  title: '客户姓名',
  service: '服务项目',
  scheduledAt: '预约时间',
  status: '状态',
  notes: '备注',
};

/** 反查：数据库列名 → 中文语义名 */
function semanticLabelOf(column: string): string | null {
  const key = (Object.keys(COLUMN_MAP) as SemanticKey[]).find(
    (k) => COLUMN_MAP[k] === column
  );
  return key ? SEMANTIC_LABELS[key] : null;
}

/** 从 PostgREST 错误中解析出「不存在的列名」 */
function extractMissingColumn(err: SupabaseQueryError): string | null {
  const msg = String(err.message ?? '');
  const m1 = msg.match(/Could not find the '([^']+)' column/i);
  if (m1) return m1[1];
  const m2 = msg.match(/column "([^"]+)" does not exist/i);
  if (m2) return m2[1];
  return null;
}

/** 从 23502 非空约束错误中解析出「缺值的必填列名」 */
function extractNotNullColumn(err: SupabaseQueryError): string | null {
  const msg = String(err.message ?? '');
  const m = msg.match(/null value in column "([^"]+)"/i);
  return m ? m[1] : null;
}

/** 优先展示的业务字段（不含 status，status 走彩色标签） */
const PREFERRED_FIELDS: { key: string; label: string }[] = [
  { key: 'client_name', label: '客户姓名' },
  { key: 'shoot_type', label: '服务项目' },
  { key: 'name', label: '姓名' },
  { key: 'title', label: '标题' },
  { key: 'customer', label: '客户' },
  { key: 'appointment_time', label: '预约时间' },
  { key: 'appointment_at', label: '预约时间' },
  { key: 'date', label: '日期' },
  { key: 'time', label: '时间' },
  { key: 'notes', label: '备注' },
  { key: 'created_at', label: '创建时间' },
  { key: 'updated_at', label: '更新时间' },
];

/* ------------------------------------------------------------------ */
/* 状态标签映射                                                        */
/* ------------------------------------------------------------------ */

type Tone = 'neutral' | 'yellow' | 'green' | 'red' | 'blue' | 'purple';

const STATUS_SYNONYMS: Record<string, string> = {
  pending: 'pending',
  待处理: 'pending',
  待确认: 'pending',
  booked: 'booked',
  reserved: 'booked',
  confirmed: 'confirmed',
  approved: 'confirmed',
  accepted: 'confirmed',
  active: 'confirmed',
  已确认: 'confirmed',
  completed: 'completed',
  done: 'completed',
  finished: 'completed',
  closed: 'completed',
  已完成: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  declined: 'cancelled',
  rejected: 'cancelled',
  已取消: 'cancelled',
};

const STATUS_STYLE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '待处理', tone: 'yellow' },
  booked: { label: '已预约', tone: 'blue' },
  confirmed: { label: '已确认', tone: 'green' },
  completed: { label: '已完成', tone: 'purple' },
  cancelled: { label: '已取消', tone: 'red' },
};

function normalizeStatus(raw: unknown): string | null {
  if (raw == null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  return (
    STATUS_SYNONYMS[value.toLowerCase()] ?? STATUS_SYNONYMS[value] ?? null
  );
}

function getStatusMeta(raw: unknown): { label: string; tone: Tone } | null {
  if (raw == null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  const norm = normalizeStatus(value);
  if (!norm) return { label: value, tone: 'neutral' };
  const style = STATUS_STYLE[norm];
  return { label: style.label, tone: style.tone };
}

/* ------------------------------------------------------------------ */
/* PostgREST 错误格式化                                                */
/* ------------------------------------------------------------------ */

function formatDbError(
  err: SupabaseQueryError,
  action: string
): { text: string; hint: string | null } {
  const code = String(err.code ?? '');
  const text = `${action}失败。PostgREST 返回：message="${err.message}" code="${code}" hint="${
    err.hint ?? ''
  }" details=${JSON.stringify(err.details ?? '')}`;

  if (code === '42703' || code === 'PGRST204') {
    return {
      text,
      hint: '该字段在表中不存在，请调整表单字段名以匹配 appointments 表的实际列名。',
    };
  }
  if (code === '42501' || /row-level security/i.test(err.message ?? '')) {
    return {
      text,
      hint:
        '请求被 RLS（行级安全）策略拒绝，需要在 Supabase 中为 appointments 表添加对应的 policy。若策略要求 user_id = auth.uid()，请在插入时带上 user_id，或给该列设置 default auth.uid()。',
    };
  }
  if (code === 'PGRST205' || code === '42P01') {
    return { text, hint: '目标表不存在，请确认 appointments 表已创建。' };
  }
  if (code === '23505') {
    return { text, hint: '唯一约束冲突，这条记录可能已存在。' };
  }
  if (code === '23502') {
    const col = extractNotNullColumn(err);
    if (col === 'shoot_type') {
      return {
        text,
        hint:
          '缺少必填列 shoot_type（前端「服务项目」）。请检查「服务项目」是否已选择，或该下拉是否被清空。',
      };
    }
    if (col) {
      return {
        text,
        hint: `缺少必填字段：${col}（该列不允许为空）。请补齐该字段后重试；其它 NOT NULL 列也可能同样需要补。`,
      };
    }
    return {
      text,
      hint: '有 NOT NULL 列缺值，请按上方 message 里的列名补齐表单字段。',
    };
  }
  if (code === '22P02') {
    return {
      text,
      hint: '该字段可能是枚举类型，取值不合法。请按数据库允许的枚举值填写（原文见上方 message）。',
    };
  }
  if (code === '23514') {
    if (/shoot_type/i.test(err.message ?? '')) {
      return {
        text,
        hint:
          '数据库存在约束 appointments_shoot_type_check，限制 shoot_type 的合法取值。请执行 `alter table public.appointments drop constraint appointments_shoot_type_check;`（或改成包含四个选项的新约束）。',
      };
    }
    return {
      text,
      hint:
        '该字段受 CHECK 约束限制，取值不合法。请按数据库允许的值填写（原文见上方 message）。',
    };
  }
  return { text, hint: null };
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

export default function AppointmentsPage() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [items, setItems] = useState<Appointment[]>([]);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorHint, setLoadErrorHint] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionErrorHint, setActionErrorHint] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);

  // 新建弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formErrorHint, setFormErrorHint] = useState<string | null>(null);
  const [form, setForm] = useState({
    clientName: '',
    service: DEFAULT_SERVICE,
    scheduledAt: '',
    notes: '',
    status: 'pending',
  });
  /** client_name 为 NOT NULL：空值时阻止提交并内联提示 */
  const [nameMissing, setNameMissing] = useState(false);
  /** 服务项目（shoot_type）为 NOT NULL：空值时阻止提交并内联提示 */
  const [serviceMissing, setServiceMissing] = useState(false);

  /* ---------------- 数据加载 ---------------- */

  const loadAppointments = useCallback(async () => {
    setLoading(true);
    setRefreshing(true);
    setLoadError(null);
    setLoadErrorHint(null);
    try {
      // 先尝试 order by created_at desc
      let { data, error: qErr } = await supabase
        .from('appointments')
        .select('*')
        .order('created_at', { ascending: false });

      // 失败则退化为不带 order
      if (qErr || !data) {
        const { data: fallback, error: qErr2 } = await supabase
          .from('appointments')
          .select('*');

        if (qErr2) {
          const formatted = formatDbError(qErr2 as SupabaseQueryError, '读取 appointments 表');
          setLoadError(formatted.text);
          setLoadErrorHint(formatted.hint);
          setItems([]);
          return;
        }
        data = fallback;
      }

      setItems((data ?? []) as Appointment[]);
    } catch (err) {
      setLoadError(`请求异常：${(err as Error).message ?? err}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/login');
        return;
      }
      setSessionEmail(session.user?.email ?? null);
      setUserId(session.user?.id ?? null);
      await loadAppointments();
    })();
  }, [router, loadAppointments]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace('/login');
  };

  /* ---------------- 新建 ---------------- */

  const openModal = () => {
    setForm({
      clientName: '',
      service: DEFAULT_SERVICE,
      scheduledAt: '',
      notes: '',
      status: 'pending',
    });
    setFormError(null);
    setFormErrorHint(null);
    setNameMissing(false);
    setServiceMissing(false);
    setModalOpen(true);
  };

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setSubmitting(false);
    setNameMissing(false);
    setServiceMissing(false);
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormErrorHint(null);

    // client_name 为 NOT NULL：空值直接拦截，不发请求
    if (!form.clientName.trim()) {
      setNameMissing(true);
      setFormError(
        `「${SEMANTIC_LABELS.title}」是必填项，请填写后再提交（数据库列 ${COLUMN_MAP.title} 不允许为空）。`
      );
      return;
    }
    setNameMissing(false);

    // 服务项目（shoot_type）为 NOT NULL：未选择或被清空时拦截
    if (!form.service.trim()) {
      setServiceMissing(true);
      setFormError(
        `「${SEMANTIC_LABELS.service}」是必填项，请选择后再提交（数据库列 ${COLUMN_MAP.service} 不允许为空）。`
      );
      return;
    }
    setServiceMissing(false);

    // 通过 COLUMN_MAP 生成 payload，只提交有值的字段
    const payload: Record<string, unknown> = {};
    payload[COLUMN_MAP.title] = form.clientName.trim();
    if (SERVICE_COLUMN_CONFIRMED) {
      payload[COLUMN_MAP.service] = form.service.trim();
    }

    let timeSkippedByMapping = false;
    if (form.scheduledAt) {
      const d = new Date(form.scheduledAt);
      if (isNaN(d.getTime())) {
        setFormError('预约时间格式无效，请重新选择。');
        return;
      }
      if (TIME_COLUMN_CONFIRMED) {
        payload[COLUMN_MAP.scheduledAt] = d.toISOString();
      } else {
        // 时间列名未确认：允许填写，但不写入数据库
        timeSkippedByMapping = true;
      }
    }
    if (form.notes.trim()) payload[COLUMN_MAP.notes] = form.notes.trim();
    if (form.status) payload[COLUMN_MAP.status] = form.status;

    setSubmitting(true);
    try {
      const skipped: string[] = [];
      let columnRetries = 0;
      let triedUserId = false;
      let succeeded = false;
      let finalError: { text: string; hint: string | null } | null = null;

      for (let guard = 0; guard < 5; guard++) {
        const { error } = await supabase.from('appointments').insert(payload);
        if (!error) {
          succeeded = true;
          break;
        }

        const e = error as SupabaseQueryError;
        const missing = extractMissingColumn(e);

        // 列不存在（PGRST204 / 42703）：剔除该列后重试，最多 2 次
        if (
          (e.code === 'PGRST204' || e.code === '42703') &&
          missing !== null &&
          columnRetries < 2 &&
          Object.prototype.hasOwnProperty.call(payload, missing)
        ) {
          delete payload[missing];
          skipped.push(missing);
          columnRetries += 1;
          continue;
        }

        // RLS 拒绝（42501）：若已知当前用户 id，补 user_id 后重试一次
        if (
          e.code === '42501' &&
          userId !== null &&
          !triedUserId &&
          !Object.prototype.hasOwnProperty.call(payload, 'user_id')
        ) {
          payload.user_id = userId;
          triedUserId = true;
          continue;
        }

        // 注意：23502（NOT NULL 缺值）属于必填列，绝不走「剔除重试」——
        // 剔除只会再次失败，因此直接落到下面的 formatDbError 并停止。
        finalError = formatDbError(e, '新建门店预约');
        break;
      }

      if (!succeeded) {
        setFormError(finalError?.text ?? '新建门店预约失败，请稍后重试。');
        setFormErrorHint(finalError?.hint ?? null);
        return;
      }

      // 成功提示：明确写出跳过了哪些列
      let msg = '新建门店预约成功。';
      if (skipped.length > 0) {
        const cols = skipped
          .map((c) => {
            const label = semanticLabelOf(c);
            return label ? `${c}（${label}）` : c;
          })
          .join('、');
        msg += ` 已跳过不存在的列：${cols}。`;
      }
      if (skipped.includes(COLUMN_MAP.scheduledAt) || timeSkippedByMapping) {
        msg += ' 时间字段未写入，请确认真实列名。';
      }
      if (timeSkippedByMapping) {
        msg += ' 预约时间暂未写入数据库（列名未确认）。';
      }
      console.warn('[新建门店预约] ' + msg, {
        skippedColumns: skipped,
        payload,
      });

      setModalOpen(false);
      setNotice(msg);
      await loadAppointments();
    } catch (err) {
      setFormError(`请求异常：${(err as Error).message ?? err}`);
    } finally {
      setSubmitting(false);
    }
  };

  /* ---------------- 行操作 ---------------- */

  const handleConfirmStatus = async (row: Appointment) => {
    const id = row.id;
    if (id === undefined || id === null || id === '') return;

    setBusyId(String(id));
    setActionError(null);
    setActionErrorHint(null);
    setNotice(null);
    try {
      const { data, error } = await supabase
        .from('appointments')
        .update({ status: 'confirmed' })
        .eq('id', id)
        .select();

      if (error) {
        const formatted = formatDbError(error as SupabaseQueryError, '更新状态');
        setActionError(formatted.text);
        setActionErrorHint(formatted.hint);
        return;
      }
      if (!data || data.length === 0) {
        setActionError(
          '更新请求没有报错，但返回 0 行——通常是 RLS 策略拦截了 update（静默过滤）。'
        );
        setActionErrorHint(
          '请在 Supabase 为 appointments 表添加 update policy（例如 using 与 with check 均允许当前用户）。'
        );
        return;
      }
      setNotice('状态已更新为「已确认」。');
      await loadAppointments();
    } catch (err) {
      setActionError(`请求异常：${(err as Error).message ?? err}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (row: Appointment) => {
    const id = row.id;
    if (id === undefined || id === null || id === '') return;

    const label =
      row.client_name ?? row.title ?? row.name ?? row.customer ?? `记录 ${String(id)}`;
    if (!window.confirm(`确定要删除「${String(label)}」吗？此操作不可撤销。`)) {
      return;
    }

    setBusyId(String(id));
    setActionError(null);
    setActionErrorHint(null);
    setNotice(null);
    try {
      const { data, error } = await supabase
        .from('appointments')
        .delete()
        .eq('id', id)
        .select();

      if (error) {
        const formatted = formatDbError(error as SupabaseQueryError, '删除记录');
        setActionError(formatted.text);
        setActionErrorHint(formatted.hint);
        return;
      }
      if (!data || data.length === 0) {
        setActionError(
          '删除请求没有报错，但返回 0 行——通常是 RLS 策略拦截了 delete（静默过滤）。'
        );
        setActionErrorHint(
          '请在 Supabase 为 appointments 表添加 delete policy。'
        );
        return;
      }
      setNotice('记录已删除。');
      await loadAppointments();
    } catch (err) {
      setActionError(`请求异常：${(err as Error).message ?? err}`);
    } finally {
      setBusyId(null);
    }
  };

  /* ---------------- 渲染 ---------------- */

  return (
    <div className="container">
      <div className="page-header">
        <h1>通用门店预约</h1>
        <div className="header-actions">
          {sessionEmail && (
            <span className="text-muted">当前账号：{sessionEmail}</span>
          )}
          <button className="btn btn-primary" onClick={openModal}>
            + 新建预约 · 到店
          </button>
          <button
            className="btn btn-secondary"
            onClick={loadAppointments}
            disabled={refreshing}
          >
            {refreshing ? '刷新中…' : '刷新'}
          </button>
          <button className="btn btn-danger" onClick={handleSignOut}>
            退出登录
          </button>
        </div>
      </div>

      {notice && <div className="alert alert-success">{notice}</div>}

      {loadError && (
        <div className="alert alert-error">
          {loadError}
          {loadErrorHint && (
            <div className="alert-hint">{loadErrorHint}</div>
          )}
        </div>
      )}

      {actionError && (
        <div className="alert alert-error">
          {actionError}
          {actionErrorHint && (
            <div className="alert-hint">{actionErrorHint}</div>
          )}
        </div>
      )}

      {loading ? (
        <div className="loading">加载中…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          暂无通用门店预约记录。
          {!loadError && (
            <div className="text-muted mt-8">
              点击右上角「新建预约 · 到店」创建第一条记录。
            </div>
          )}
        </div>
      ) : (
        <ul className="card-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((row, idx) => (
            <AppointmentCard
              key={String(row.id ?? idx)}
              row={row}
              busy={busyId !== null && String(row.id) === busyId}
              onConfirm={handleConfirmStatus}
              onDelete={handleDelete}
            />
          ))}
        </ul>
      )}

      <Modal open={modalOpen} onClose={closeModal}>
        <form className="modal-form" onSubmit={handleCreate}>
          <div className="modal-header">
            <h2>新建预约 · 到店</h2>
            <button
              type="button"
              className="modal-close"
              onClick={closeModal}
              aria-label="关闭"
            >
              ×
            </button>
          </div>

          {formError && (
            <div className="alert alert-error">
              {formError}
              {formErrorHint && (
                <div className="alert-hint">{formErrorHint}</div>
              )}
            </div>
          )}

          <label htmlFor="f-client">
            客户姓名 <span className="required-mark">必填</span>
          </label>
          <input
            id="f-client"
            type="text"
            placeholder="必填，例如：张三 / 王女士"
            value={form.clientName}
            onChange={(e) => {
              setForm({ ...form, clientName: e.target.value });
              if (e.target.value.trim()) setNameMissing(false);
            }}
            className={nameMissing ? 'input-invalid' : undefined}
            disabled={submitting}
          />
          {nameMissing && (
            <div className="field-error">客户姓名为必填项，请填写后再提交。</div>
          )}

          <label htmlFor="f-service">
            服务项目 <span className="required-mark">必填</span>
          </label>
          <select
            id="f-service"
            value={form.service}
            onChange={(e) => {
              setForm({ ...form, service: e.target.value });
              if (e.target.value.trim()) setServiceMissing(false);
            }}
            className={serviceMissing ? 'input-invalid' : undefined}
            disabled={submitting}
          >
            {SERVICE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {serviceMissing && (
            <div className="field-error">服务项目为必填项，请选择后再提交。</div>
          )}

          <label htmlFor="f-at">
            到店时间（建议填写）
            {!TIME_COLUMN_CONFIRMED && (
              <span className="optional-mark">暂未写入数据库</span>
            )}
          </label>
          <input
            id="f-at"
            type="datetime-local"
            value={form.scheduledAt}
            onChange={(e) =>
              setForm({ ...form, scheduledAt: e.target.value })
            }
            disabled={submitting}
          />

          <label htmlFor="f-status">状态</label>
          <select
            id="f-status"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
            disabled={submitting}
          >
            <option value="pending">待处理（pending）</option>
            <option value="confirmed">已确认（confirmed）</option>
            <option value="completed">已完成（completed）</option>
            <option value="cancelled">已取消（cancelled）</option>
          </select>

          <label htmlFor="f-notes">备注</label>
          <textarea
            id="f-notes"
            rows={3}
            placeholder="可留空"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            disabled={submitting}
          />

          <p className="form-tip">
            字段映射（已按实测列名确认）：客户姓名 → {COLUMN_MAP.title}
            （NOT NULL，必填），服务项目 → {COLUMN_MAP.service}
            （NOT NULL，必填，列名保持不变），预约时间 → {COLUMN_MAP.scheduledAt}
            ，备注 → {COLUMN_MAP.notes}，状态 → {COLUMN_MAP.status}
            。若仍有列名不匹配会自动跳过并重试并在成功提示里说明；NOT NULL
            缺值（23502）与 CHECK 约束（23514）不会重试，会提示具体原因。
          </p>

          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={closeModal}
              disabled={submitting}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting ? '提交中…' : '创建'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 弹窗                                                                */
/* ------------------------------------------------------------------ */

function Modal({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 单条卡片                                                            */
/* ------------------------------------------------------------------ */

function AppointmentCard({
  row,
  busy,
  onConfirm,
  onDelete,
}: {
  row: Appointment;
  busy: boolean;
  onConfirm: (row: Appointment) => void;
  onDelete: (row: Appointment) => void;
}) {
  const hasId = row.id !== undefined && row.id !== null && row.id !== '';

  const statusMeta = useMemo(() => getStatusMeta(row.status), [row.status]);
  const alreadyConfirmed = useMemo(
    () => normalizeStatus(row.status) === 'confirmed',
    [row.status]
  );

  const preferred = useMemo(() => {
    const found: { key: string; label: string; value: unknown }[] = [];
    const used = new Set<string>();
    for (const { key, label } of PREFERRED_FIELDS) {
      const v = row[key];
      if (v !== undefined && v !== null && v !== '') {
        found.push({ key, label, value: v });
        used.add(key);
      }
    }
    return { found, used };
  }, [row]);

  // 头部标题：client_name / name / title / customer 中第一个有值的
  const headline = useMemo(() => {
    const t = row.client_name ?? row.name ?? row.title ?? row.customer;
    return t !== undefined && t !== null && t !== '' ? String(t) : '未命名预约';
  }, [row]);

  // 被头部或 status 用掉的字段，额外字段里要排除
  const consumed = useMemo(() => {
    const set = new Set(preferred.used);
    for (const k of [
      'client_name',
      'shoot_type',
      'title',
      'name',
      'customer',
      'status',
    ]) {
      set.add(k);
    }
    return set;
  }, [preferred.used]);

  const extras = useMemo(() => {
    const out: { key: string; value: unknown }[] = [];
    for (const [k, v] of Object.entries(row)) {
      if (consumed.has(k)) continue;
      if (isHiddenField(k)) continue;
      if (v === null || v === undefined || v === '') continue;
      out.push({ key: k, value: v });
    }
    return out;
  }, [row, consumed]);

  return (
    <li className="card">
      <div className="card-head">
        <div className="card-head-main">
          <h3>{headline}</h3>
          {statusMeta && (
            <span className={`badge badge-${statusMeta.tone}`}>
              {statusMeta.label}
            </span>
          )}
        </div>
        <div className="card-actions">
          <button
            className="btn btn-sm btn-secondary"
            disabled={!hasId || busy || alreadyConfirmed}
            title={
              !hasId
                ? '该记录没有 id 字段，无法更新状态'
                : alreadyConfirmed
                ? '该记录已是「已确认」状态'
                : undefined
            }
            onClick={() => onConfirm(row)}
          >
            {alreadyConfirmed ? '已确认' : '确认状态'}
          </button>
          <button
            className="btn btn-sm btn-danger"
            disabled={!hasId || busy}
            title={
              !hasId ? '该记录没有 id 字段，无法删除' : undefined
            }
            onClick={() => onDelete(row)}
          >
            删除
          </button>
        </div>
      </div>

      {preferred.found.length > 0 && (
        <div className="card-body">
          {preferred.found.map((f) => (
            <div className="field" key={f.key}>
              <span className="label">{f.label}</span>
              <span className="value">
                {looksLikeDateField(f.key)
                  ? formatDateLike(f.value)
                  : String(f.value)}
              </span>
            </div>
          ))}
        </div>
      )}

      {extras.length > 0 && (
        <div className="extra-fields">
          {extras.map((e) => (
            <div className="field" key={e.key}>
              <span className="label">{e.key}</span>
              <span className="value">
                {looksLikeDateField(e.key)
                  ? formatDateLike(e.value)
                  : typeof e.value === 'object'
                  ? JSON.stringify(e.value)
                  : String(e.value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
