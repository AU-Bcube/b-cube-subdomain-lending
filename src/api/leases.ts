import type { RecordInput, TargetKind } from "../../shared/rules";
import type { LeaseDetail, LeaseItem, LeasesResponse, NameAvailability, RecheckResponse } from "../../shared/schemas";
import { api } from "./client";

const leasePath = (id: string) => `/api/leases/${encodeURIComponent(id)}`;

export const leasesApi = {
  list: () => api<LeasesResponse>("/api/leases"),
  get: (id: string) => api<LeaseDetail>(leasePath(id)),
  availability: (name: string, signal?: AbortSignal) =>
    api<NameAvailability>(`/api/names/${encodeURIComponent(name)}/availability`, signal ? { signal } : {}),
  create: (input: { name: string; targetKind: TargetKind; records: RecordInput[] }) =>
    api<LeaseItem>("/api/leases", { method: "POST", json: input }),
  replaceRecords: (id: string, records: RecordInput[]) =>
    api<{ ok: true; changed: boolean }>(`${leasePath(id)}/records`, { method: "PUT", json: { records } }),
  renew: (id: string) => api<{ ok: true; expiresAt: number }>(`${leasePath(id)}/renew`, { method: "POST" }),
  recheck: (id: string) => api<RecheckResponse>(`${leasePath(id)}/recheck`, { method: "POST" }),
  release: (id: string) => api<{ ok: true }>(leasePath(id), { method: "DELETE" }),
};
