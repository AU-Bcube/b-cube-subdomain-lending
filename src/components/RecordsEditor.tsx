/**
 * 연결 대상별 레코드 입력 폼. 생성 3단계와 상세 화면 편집에서 함께 쓴다.
 * 검증은 서버와 같은 shared/rules.ts의 validateRecordSet으로 먼저 한다.
 */
import { Button, InlineNotification, Select, SelectItem, Stack, TextInput, Toggle } from "@carbon/react";
import { Add, TrashCan } from "@carbon/icons-react";
import {
  MAX_IP_RECORDS_PER_TYPE,
  MAX_TXT_RECORDS,
  VERCEL_DEFAULT_CNAME,
  validateRecordSet,
  vercelVerifyPrefix,
  type NormalizedRecord,
  type RecordInput,
  type TargetKind,
} from "../../shared/rules";
import type { RecordFieldError, RecordView } from "../../shared/schemas";

export interface RecordsForm {
  cname: string;
  ips: Array<{ key: string; type: "A" | "AAAA"; content: string }>;
  /** ip 타입의 A/AAAA 전체에 적용 */
  proxied: boolean;
  txts: Array<{ key: string; host: string; content: string }>;
}

let keySeq = 0;
const newKey = () => `k${++keySeq}`;
const CNAME_KEY = "cname";

export function txtHosts(kind: TargetKind, fqdn: string, zone: string): Array<{ value: string; label: string }> {
  const acme = { value: `_acme-challenge.${fqdn}`, label: `_acme-challenge.${fqdn} (인증서 발급)` };
  switch (kind) {
    case "vercel":
      return [{ value: `_vercel.${zone}`, label: `_vercel.${zone} (Vercel 도메인 검증)` }];
    case "ip":
      return [{ value: fqdn, label: `${fqdn} (본 이름)` }, acme];
    case "cname":
      return [acme];
  }
}

export function emptyForm(kind: TargetKind): RecordsForm {
  return {
    cname: kind === "vercel" ? VERCEL_DEFAULT_CNAME : "",
    ips: kind === "ip" ? [{ key: newKey(), type: "A", content: "" }] : [],
    proxied: false,
    txts: [],
  };
}

export function formFromRecords(kind: TargetKind, records: readonly RecordView[]): RecordsForm {
  const form = emptyForm(kind);
  form.cname = records.find((r) => r.type === "CNAME")?.content ?? form.cname;
  const ips = records.filter((r): r is RecordView & { type: "A" | "AAAA" } => r.type === "A" || r.type === "AAAA");
  if (kind === "ip") {
    form.ips = ips.length ? ips.map((r) => ({ key: newKey(), type: r.type, content: r.content })) : form.ips;
    form.proxied = ips.some((r) => r.proxied);
  }
  form.txts = records.filter((r) => r.type === "TXT").map((r) => ({ key: newKey(), host: r.host, content: r.content }));
  return form;
}

/** 폼 → API 입력. keys[i]는 records[i]를 만든 입력란의 key다. 빈 입력란은 건너뛴다. */
export function formToRecords(kind: TargetKind, fqdn: string, form: RecordsForm): { records: RecordInput[]; keys: string[] } {
  const records: RecordInput[] = [];
  const keys: string[] = [];
  if (kind === "ip") {
    for (const ip of form.ips) {
      if (!ip.content.trim()) continue;
      records.push({ type: ip.type, host: fqdn, content: ip.content.trim(), proxied: form.proxied });
      keys.push(ip.key);
    }
  } else {
    records.push({ type: "CNAME", host: fqdn, content: form.cname.trim() });
    keys.push(CNAME_KEY);
  }
  for (const txt of form.txts) {
    if (!txt.content) continue;
    records.push({ type: "TXT", host: txt.host, content: txt.content });
    keys.push(txt.key);
  }
  return { records, keys };
}

export interface FormErrors {
  /** 입력란 key → 메시지 */
  fields: Record<string, string>;
  /** 특정 입력란에 속하지 않는 오류 */
  general: string[];
}

export const NO_ERRORS: FormErrors = { fields: {}, general: [] };

export function mapErrors(errors: readonly RecordFieldError[], keys: readonly string[]): FormErrors {
  const out: FormErrors = { fields: {}, general: [] };
  for (const e of errors) {
    const key = e.index === undefined ? undefined : keys[e.index];
    if (key && !out.fields[key]) out.fields[key] = e.message;
    else if (!key) out.general.push(e.message);
  }
  return out;
}

export function validateForm(
  kind: TargetKind,
  name: string,
  zone: string,
  form: RecordsForm,
): { ok: true; records: NormalizedRecord[]; input: RecordInput[] } | { ok: false; errors: FormErrors } {
  const { records, keys } = formToRecords(kind, `${name}.${zone}`, form);
  const result = validateRecordSet({ name, zone, targetKind: kind, records });
  if (result.ok) return { ok: true, records: result.records, input: records };
  return { ok: false, errors: mapErrors(result.errors, keys) };
}

interface RecordsEditorProps {
  kind: TargetKind;
  name: string;
  zone: string;
  form: RecordsForm;
  errors: FormErrors;
  onChange: (form: RecordsForm) => void;
}

export function RecordsEditor({ kind, name, zone, form, errors, onChange }: RecordsEditorProps) {
  const fqdn = `${name}.${zone}`;
  const hosts = txtHosts(kind, fqdn, zone);
  const set = (patch: Partial<RecordsForm>) => onChange({ ...form, ...patch });
  const countType = (type: "A" | "AAAA") => form.ips.filter((ip) => ip.type === type).length;

  return (
    <Stack gap={6}>
      {kind !== "ip" && (
        <TextInput
          id="record-cname"
          labelText={kind === "vercel" ? "CNAME 값 (Vercel)" : "CNAME 대상 도메인"}
          helperText={
            kind === "vercel"
              ? "기본값은 cname.vercel-dns.com입니다. Vercel이 프로젝트별 값(예: xxxx.vercel-dns-017.com)을 안내하면 그 값을 넣으세요."
              : "연결할 서비스가 안내한 호스트 이름 (예: my-app.netlify.app). IP 주소와 b-cube.kr 하위 도메인은 쓸 수 없습니다."
          }
          placeholder={kind === "vercel" ? VERCEL_DEFAULT_CNAME : "my-app.example.com"}
          value={form.cname}
          invalid={Boolean(errors.fields[CNAME_KEY])}
          invalidText={errors.fields[CNAME_KEY]}
          onChange={(e) => set({ cname: e.target.value })}
        />
      )}

      {kind === "ip" && (
        <fieldset className="records-fieldset">
          <legend className="cds--label">서버 IP (A는 IPv4, AAAA는 IPv6, 타입별 최대 {MAX_IP_RECORDS_PER_TYPE}개)</legend>
          <Stack gap={4}>
            {form.ips.map((ip, i) => (
              <div key={ip.key} className="record-row">
                <Select
                  id={`ip-type-${ip.key}`}
                  labelText="타입"
                  hideLabel
                  value={ip.type}
                  onChange={(e) => set({ ips: form.ips.map((x) => (x.key === ip.key ? { ...x, type: e.target.value as "A" | "AAAA" } : x)) })}
                >
                  <SelectItem value="A" text="A" />
                  <SelectItem value="AAAA" text="AAAA" />
                </Select>
                <TextInput
                  id={`ip-${ip.key}`}
                  labelText={`IP ${i + 1}`}
                  hideLabel
                  placeholder={ip.type === "A" ? "3.35.120.14" : "2406:da12::1"}
                  value={ip.content}
                  invalid={Boolean(errors.fields[ip.key])}
                  invalidText={errors.fields[ip.key]}
                  onChange={(e) => set({ ips: form.ips.map((x) => (x.key === ip.key ? { ...x, content: e.target.value } : x)) })}
                />
                <Button
                  kind="ghost"
                  size="md"
                  hasIconOnly
                  renderIcon={TrashCan}
                  iconDescription="삭제"
                  tooltipPosition="left"
                  disabled={form.ips.length <= 1}
                  onClick={() => set({ ips: form.ips.filter((x) => x.key !== ip.key) })}
                />
              </div>
            ))}
            <div>
              <Button
                kind="tertiary"
                size="sm"
                renderIcon={Add}
                disabled={countType("A") >= MAX_IP_RECORDS_PER_TYPE && countType("AAAA") >= MAX_IP_RECORDS_PER_TYPE}
                onClick={() =>
                  set({ ips: [...form.ips, { key: newKey(), type: countType("A") < MAX_IP_RECORDS_PER_TYPE ? "A" : "AAAA", content: "" }] })
                }
              >
                IP 추가
              </Button>
            </div>
            <Toggle
              id="record-proxied"
              labelText="Cloudflare 프록시"
              labelA="끔 (DNS만)"
              labelB="켬 (주황 구름)"
              toggled={form.proxied}
              onToggle={(checked) => set({ proxied: checked })}
            />
            <p className="cds--form__helper-text">
              프록시를 켜면 방문자는 Cloudflare를 거쳐 접속하고 서버 IP가 드러나지 않습니다. 서버의 80/443 포트만 프록시됩니다.
            </p>
          </Stack>
        </fieldset>
      )}

      <fieldset className="records-fieldset">
        <legend className="cds--label">
          TXT 레코드 (선택, 최대 {MAX_TXT_RECORDS}개)
          {kind === "vercel" && ` — Vercel이 도메인 검증을 요구할 때만 입력`}
        </legend>
        <Stack gap={4}>
          {form.txts.map((txt, i) => (
            <div key={txt.key} className="record-row record-row--txt">
              {hosts.length > 1 ? (
                <Select
                  id={`txt-host-${txt.key}`}
                  labelText="호스트"
                  hideLabel
                  value={txt.host}
                  onChange={(e) => set({ txts: form.txts.map((x) => (x.key === txt.key ? { ...x, host: e.target.value } : x)) })}
                >
                  {hosts.map((h) => (
                    <SelectItem key={h.value} value={h.value} text={h.label} />
                  ))}
                </Select>
              ) : (
                <span className="mono record-host">{hosts[0]?.value}</span>
              )}
              <TextInput
                id={`txt-${txt.key}`}
                labelText={`TXT ${i + 1}`}
                hideLabel
                placeholder={txt.host === `_vercel.${zone}` ? `${vercelVerifyPrefix(fqdn)}...` : "값"}
                value={txt.content}
                invalid={Boolean(errors.fields[txt.key])}
                invalidText={errors.fields[txt.key]}
                onChange={(e) => set({ txts: form.txts.map((x) => (x.key === txt.key ? { ...x, content: e.target.value } : x)) })}
              />
              <Button
                kind="ghost"
                size="md"
                hasIconOnly
                renderIcon={TrashCan}
                iconDescription="삭제"
                tooltipPosition="left"
                onClick={() => set({ txts: form.txts.filter((x) => x.key !== txt.key) })}
              />
            </div>
          ))}
          <div>
            <Button
              kind="tertiary"
              size="sm"
              renderIcon={Add}
              disabled={form.txts.length >= MAX_TXT_RECORDS}
              onClick={() =>
                set({
                  txts: [
                    ...form.txts,
                    { key: newKey(), host: hosts[0]!.value, content: kind === "vercel" ? vercelVerifyPrefix(fqdn) : "" },
                  ],
                })
              }
            >
              TXT 추가
            </Button>
          </div>
        </Stack>
      </fieldset>

      {errors.general.map((message) => (
        <InlineNotification key={message} kind="error" title="레코드를 확인하세요" subtitle={message} hideCloseButton lowContrast />
      ))}
    </Stack>
  );
}
