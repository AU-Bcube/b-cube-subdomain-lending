import {
  Button,
  ButtonSet,
  Column,
  Grid,
  InlineLoading,
  InlineNotification,
  SkeletonText,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Tag,
  Tile,
} from "@carbon/react";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { LeaseDetail } from "../../shared/schemas";
import { ApiError } from "../api/client";
import { leasesApi } from "../api/leases";
import { ConnectionGuide } from "../components/ConnectionGuide";
import { RecordPreview } from "../components/RecordPreview";
import { formFromRecords, formToRecords, mapErrors, NO_ERRORS, RecordsEditor, validateForm, type FormErrors, type RecordsForm } from "../components/RecordsEditor";
import { ReleaseModal } from "../components/ReleaseModal";
import { useToast } from "../components/Toasts";
import { daysUntil, formatDate, formatDateTime } from "../lib/format";
import { ACTOR_ROLE_LABELS, AUDIT_ACTION_LABELS, LEASE_STATUS_LABELS, STATUS_REASON_LABELS, TARGET_KIND_LABELS } from "../lib/labels";
import { useAsync } from "../lib/useAsync";
import { useSession } from "../session";

function Editor({ lease, onDone, onCancel }: { lease: LeaseDetail; onDone: () => void; onCancel: () => void }) {
  const notify = useToast();
  const zone = lease.fqdn.slice(lease.name.length + 1);
  const [form, setForm] = useState<RecordsForm>(() => formFromRecords(lease.targetKind, lease.records));
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = async () => {
    const result = validateForm(lease.targetKind, lease.name, zone, form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors(NO_ERRORS);
    setSaving(true);
    setSaveError(null);
    try {
      const r = await leasesApi.replaceRecords(lease.id, result.input);
      notify("success", r.changed ? "레코드를 바꿨습니다" : "바뀐 내용이 없습니다", lease.fqdn);
      onDone();
    } catch (err) {
      setSaving(false);
      if (err instanceof ApiError && err.code === "invalid_records" && err.errors) {
        setErrors(mapErrors(err.errors, formToRecords(lease.targetKind, lease.fqdn, form).keys));
        return;
      }
      setSaveError(err instanceof Error ? err.message : "저장하지 못했습니다.");
    }
  };

  return (
    <Tile className="section-tile">
      <Stack gap={6}>
        <h2 className="cds--type-heading-03">레코드 편집</h2>
        <p className="cds--type-body-compact-01">
          저장하면 새 레코드를 먼저 만들고, 그다음 기존 레코드를 지웁니다. 바뀌지 않은 레코드는 그대로 둡니다.
        </p>
        <RecordsEditor kind={lease.targetKind} name={lease.name} zone={zone} form={form} errors={errors} onChange={setForm} />
        {saveError && <InlineNotification kind="error" title="저장하지 못했습니다" subtitle={saveError} hideCloseButton lowContrast />}
        <ButtonSet>
          <Button kind="secondary" disabled={saving} onClick={onCancel}>
            취소
          </Button>
          {saving ? <InlineLoading description="저장 중…" className="inline-loading-btn" /> : <Button onClick={() => void save()}>저장</Button>}
        </ButtonSet>
      </Stack>
    </Tile>
  );
}

function auditSummary(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.reason === "string") return STATUS_REASON_LABELS[d.reason] ?? d.reason;
  if (typeof d.detail === "string") return d.detail;
  if (typeof d.cause === "string") return d.cause === "lease_expired" ? "대여 기간 만료" : "일시 중지 기간 초과";
  return null;
}

export function LeaseDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { refresh } = useSession();
  const notify = useToast();
  const navigate = useNavigate();
  const { data: lease, loading, error, reload } = useAsync(() => leasesApi.get(id), [id]);
  const [busy, setBusy] = useState<"renew" | "recheck" | null>(null);
  const [releasing, setReleasing] = useState(false);
  const editing = params.get("edit") === "1" && lease?.status === "active";
  const setEditing = (on: boolean) => setParams(on ? { edit: "1" } : {}, { replace: true });

  if (loading && !lease) {
    return (
      <Grid>
        <Column sm={4} md={8} lg={16}>
          <SkeletonText heading width="40%" />
          <SkeletonText paragraph lineCount={6} />
        </Column>
      </Grid>
    );
  }
  if (error || !lease) {
    return (
      <Grid>
        <Column sm={4} md={8} lg={16}>
          <Stack gap={5}>
            <InlineNotification kind="error" title="불러오지 못했습니다" subtitle={error ?? "서브도메인을 찾을 수 없습니다."} hideCloseButton lowContrast />
            <Link to="/" className="cds--link">
              ← 내 서브도메인
            </Link>
          </Stack>
        </Column>
      </Grid>
    );
  }

  const st = LEASE_STATUS_LABELS[lease.status];
  const live = lease.status === "active" || lease.status === "suspended";

  const run = async (kind: "renew" | "recheck") => {
    setBusy(kind);
    try {
      if (kind === "renew") {
        const r = await leasesApi.renew(lease.id);
        notify("success", "연장했습니다", `${formatDate(r.expiresAt)}까지`);
      } else {
        const r = await leasesApi.recheck(lease.id);
        if (r.reactivated) notify("success", "다시 활성화했습니다", r.detail);
        else if (r.ok) notify("success", "정상입니다", r.detail);
        else notify("warning", "아직 응답이 없습니다", r.detail);
      }
      reload();
      await refresh();
    } catch (err) {
      notify("error", kind === "renew" ? "연장하지 못했습니다" : "재확인하지 못했습니다", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Grid>
      <Column sm={4} md={8} lg={16}>
        <Stack gap={6}>
          <div>
            <Link to="/" className="cds--link">
              ← 내 서브도메인
            </Link>
            <div className="detail-title">
              <h1 className="cds--type-heading-05 mono break">{lease.fqdn}</h1>
              <Tag type={st.tag}>{st.text}</Tag>
            </div>
            <p className="cds--type-body-compact-01 secondary">
              {TARGET_KIND_LABELS[lease.targetKind]} · 생성 {formatDate(lease.createdAt)} ·{" "}
              {live ? `만료 ${formatDate(lease.expiresAt)} (${daysUntil(lease.expiresAt)}일 남음)` : `종료 ${formatDate(lease.endedAt)}`}
            </p>
          </div>

          {lease.status === "suspended" && (
            <InlineNotification
              kind="error"
              title="일시 중지됨"
              subtitle="연결 대상이 계속 응답하지 않아 DNS 레코드를 내렸습니다(서브도메인 탈취 방지). 서버나 배포를 고친 뒤 재확인을 누르면 레코드를 다시 만듭니다."
              hideCloseButton
              lowContrast
            />
          )}
          {lease.status === "active" && lease.renewable && (
            <InlineNotification kind="warning" title="만료 임박" subtitle="만료되면 DNS 레코드가 삭제됩니다. 계속 쓰려면 연장하세요." hideCloseButton lowContrast />
          )}

          {live && (
            <div className="detail-actions">
              <Button kind="primary" size="md" disabled={lease.status !== "active" || editing} onClick={() => setEditing(true)}>
                편집
              </Button>
              <Button kind="secondary" size="md" disabled={!lease.renewable || busy !== null} onClick={() => void run("renew")}>
                {busy === "renew" ? "연장 중…" : "연장"}
              </Button>
              <Button kind="tertiary" size="md" disabled={busy !== null} onClick={() => void run("recheck")}>
                {busy === "recheck" ? "확인 중…" : "재확인"}
              </Button>
              <Button kind="danger--tertiary" size="md" onClick={() => setReleasing(true)}>
                반납
              </Button>
            </div>
          )}

          {editing ? (
            <Editor
              lease={lease}
              onCancel={() => setEditing(false)}
              onDone={() => {
                setEditing(false);
                reload();
              }}
            />
          ) : (
            <section className="stack-section">
              <h2 className="cds--type-heading-03">DNS 레코드</h2>
              <RecordPreview records={lease.records} />
            </section>
          )}

          <section className="stack-section">
            <h2 className="cds--type-heading-03">헬스 상태</h2>
            <StructuredListWrapper aria-label="헬스 상태" isCondensed>
              <StructuredListBody>
                <StructuredListRow>
                  <StructuredListCell>마지막 검사</StructuredListCell>
                  <StructuredListCell>{formatDateTime(lease.lastHealthCheckAt)}</StructuredListCell>
                </StructuredListRow>
                <StructuredListRow>
                  <StructuredListCell>결과</StructuredListCell>
                  <StructuredListCell>{lease.lastHealthDetail ?? "아직 검사하지 않았습니다"}</StructuredListCell>
                </StructuredListRow>
                <StructuredListRow>
                  <StructuredListCell>마지막 정상</StructuredListCell>
                  <StructuredListCell>{formatDateTime(lease.lastHealthOkAt)}</StructuredListCell>
                </StructuredListRow>
                <StructuredListRow>
                  <StructuredListCell>연속 실패</StructuredListCell>
                  <StructuredListCell>{lease.healthFailCount}일</StructuredListCell>
                </StructuredListRow>
              </StructuredListBody>
            </StructuredListWrapper>
          </section>

          {live && <ConnectionGuide kind={lease.targetKind} fqdn={lease.fqdn} />}

          <section className="stack-section">
            <h2 className="cds--type-heading-03">변경 이력</h2>
            {lease.auditLogs.length === 0 ? (
              <p>기록이 없습니다.</p>
            ) : (
              <ol className="timeline">
                {lease.auditLogs.map((log) => {
                  const summary = auditSummary(log.detail);
                  return (
                    <li key={log.id}>
                      <div className="timeline-head">
                        <strong>{AUDIT_ACTION_LABELS[log.action] ?? log.action}</strong>
                        <span className="secondary">
                          {formatDateTime(log.at)} · {ACTOR_ROLE_LABELS[log.actorRole]}
                        </span>
                      </div>
                      {summary && <div className="cell-sub">{summary}</div>}
                      {log.detail != null && (
                        <details>
                          <summary className="cds--link">자세히</summary>
                          <pre className="json">{JSON.stringify(log.detail, null, 2)}</pre>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </Stack>
      </Column>

      <ReleaseModal
        open={releasing}
        name={lease.name}
        fqdn={lease.fqdn}
        onClose={() => setReleasing(false)}
        onConfirm={async () => {
          await leasesApi.release(lease.id);
          notify("success", "반납했습니다", lease.fqdn);
          await refresh();
          navigate("/");
        }}
      />
    </Grid>
  );
}
