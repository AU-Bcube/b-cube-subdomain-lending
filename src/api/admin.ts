import type { AdminLeaseItem, AdminUserItem, AuditLogItem, DriftResponse, Paged, RecoverOpsResponse } from "../../shared/schemas";
import { api } from "./client";

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export const adminApi = {
  leases: (p: { status?: string; q?: string; page: number }) => api<Paged<AdminLeaseItem>>(`/api/admin/leases${qs(p)}`),
  revoke: (id: string, reason: string) =>
    api<{ ok: true }>(`/api/admin/leases/${encodeURIComponent(id)}/revoke`, { method: "POST", json: { reason } }),
  users: (p: { q?: string; banned?: string; page: number }) => api<Paged<AdminUserItem>>(`/api/admin/users${qs(p)}`),
  ban: (email: string, reason: string) =>
    api<{ ok: true; revokedLeases: string[]; failedLeases: string[] }>(`/api/admin/users/${encodeURIComponent(email)}/ban`, {
      method: "POST",
      json: { reason },
    }),
  unban: (email: string, reason: string) =>
    api<{ ok: true }>(`/api/admin/users/${encodeURIComponent(email)}/unban`, { method: "POST", json: { reason } }),
  auditLogs: (p: { actor?: string; action?: string; lease?: string; from?: number; to?: number; page: number }) =>
    api<Paged<AuditLogItem>>(`/api/admin/audit-logs${qs(p)}`),
  drift: () => api<DriftResponse>("/api/admin/drift"),
  recoverOps: () => api<RecoverOpsResponse>("/api/admin/dns-ops/recover", { method: "POST" }),
};
