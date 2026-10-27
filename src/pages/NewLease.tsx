import {
  Button,
  ButtonSet,
  Column,
  Grid,
  InlineLoading,
  InlineNotification,
  ProgressIndicator,
  ProgressStep,
  RadioTile,
  Stack,
  TextInput,
  TileGroup,
} from "@carbon/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { checkNameFormat, NAME_REASON_MESSAGES, TARGET_KINDS, type NormalizedRecord, type RecordInput, type TargetKind } from "../../shared/rules";
import type { LeaseItem, NameAvailability } from "../../shared/schemas";
import { ApiError } from "../api/client";
import { leasesApi } from "../api/leases";
import { ConnectionGuide } from "../components/ConnectionGuide";
import { RecordPreview } from "../components/RecordPreview";
import { emptyForm, mapErrors, NO_ERRORS, RecordsEditor, validateForm, formToRecords, type FormErrors, type RecordsForm } from "../components/RecordsEditor";
import { useToast } from "../components/Toasts";
import { useDebounced } from "../lib/useDebounced";
import { useSession } from "../session";

const STEPS = ["이름", "연결 대상", "레코드 입력", "확인"];

const KIND_DESCRIPTIONS: Record<TargetKind, { title: string; body: string }> = {
  vercel: { title: "Vercel", body: "Vercel에 배포한 프로젝트를 연결합니다. CNAME 값이 미리 채워집니다." },
  ip: { title: "서버 IP (AWS 등)", body: "EC2, Lightsail, 집 서버 등 공인 IP가 있는 서버를 A/AAAA 레코드로 연결합니다." },
  cname: { title: "기타 CNAME", body: "Netlify, GitHub Pages, Render 등 호스트 이름을 안내하는 서비스를 연결합니다." },
};

type NameState = { status: "idle" | "checking" } | { status: "done"; result: NameAvailability } | { status: "error"; message: string };

export function NewLeasePage() {
  const { me, refresh } = useSession();
  const notify = useToast();
  const navigate = useNavigate();
  const zone = me?.zone ?? "";

  const [step, setStep] = useState(0);
  const [rawName, setRawName] = useState("");
  const name = rawName.trim().toLowerCase();
  const debouncedName = useDebounced(name, 300);
  const [nameState, setNameState] = useState<NameState>({ status: "idle" });
  const [kind, setKind] = useState<TargetKind | null>(null);
  const [forms, setForms] = useState<Partial<Record<TargetKind, RecordsForm>>>({});
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [preview, setPreview] = useState<{ records: NormalizedRecord[]; input: RecordInput[] } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<LeaseItem | null>(null);

  const formatError = name ? checkNameFormat(name) : null;

  // 이름 가용성: 형식이 맞을 때만 300ms 디바운스 후 서버에 묻는다.
  useEffect(() => {
    if (!debouncedName || checkNameFormat(debouncedName)) {
      setNameState({ status: "idle" });
      return;
    }
    const ctrl = new AbortController();
    setNameState({ status: "checking" });
    leasesApi.availability(debouncedName, ctrl.signal).then(
      (result) => !ctrl.signal.aborted && setNameState({ status: "done", result }),
      (err: unknown) => !ctrl.signal.aborted && setNameState({ status: "error", message: err instanceof Error ? err.message : "확인하지 못했습니다." }),
    );
    return () => ctrl.abort();
  }, [debouncedName]);

  const form = kind ? (forms[kind] ?? emptyForm(kind)) : null;
  const nameReady = !formatError && debouncedName === name && nameState.status === "done" && nameState.result.available;
  const nameMessage = useMemo(() => {
    if (!name) return { invalid: false, text: `영문 소문자, 숫자, 하이픈 3~32자. 주소는 이름.${zone}이 됩니다.` };
    if (formatError) return { invalid: true, text: NAME_REASON_MESSAGES[formatError] };
    if (debouncedName !== name || nameState.status === "checking") return { invalid: false, text: "확인 중…" };
    if (nameState.status === "error") return { invalid: true, text: nameState.message };
    if (nameState.status === "done") {
      return nameState.result.available
        ? { invalid: false, text: `${name}.${zone}을(를) 사용할 수 있습니다.` }
        : { invalid: true, text: NAME_REASON_MESSAGES[nameState.result.reason ?? "taken"] };
    }
    return { invalid: false, text: "" };
  }, [name, zone, formatError, debouncedName, nameState]);

  if (!me) return null;

  if (created) {
    return (
      <Grid>
        <Column sm={4} md={8} lg={{ span: 10, offset: 3 }}>
          <Stack gap={6}>
            <InlineNotification kind="success" title="서브도메인을 만들었습니다" subtitle={created.fqdn} hideCloseButton lowContrast />
            <RecordPreview records={created.records} />
            <ConnectionGuide kind={created.targetKind} fqdn={created.fqdn} />
            <ButtonSet>
              <Button kind="secondary" onClick={() => navigate("/")}>
                목록으로
              </Button>
              <Button onClick={() => navigate(`/leases/${created.id}`)}>상세 보기</Button>
            </ButtonSet>
          </Stack>
        </Column>
      </Grid>
    );
  }

  const limitReached = me.limits.used >= me.limits.max;

  const goRecords = () => {
    if (!kind || !form) return;
    const result = validateForm(kind, name, zone, form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors(NO_ERRORS);
    setPreview({ records: result.records, input: result.input });
    setStep(3);
  };

  const submit = async () => {
    if (!kind || !form || !preview) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const lease = await leasesApi.create({ name, targetKind: kind, records: preview.input });
      await refresh();
      notify("success", "생성했습니다", lease.fqdn);
      setCreated(lease);
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError && err.code === "invalid_records" && err.errors) {
        setErrors(mapErrors(err.errors, formToRecords(kind, `${name}.${zone}`, form).keys));
        setStep(2);
        return;
      }
      if (err instanceof ApiError && err.code in NAME_REASON_MESSAGES) {
        setNameState({ status: "done", result: { available: false, reason: err.code as keyof typeof NAME_REASON_MESSAGES } });
        setStep(0);
        return;
      }
      setSubmitError(err instanceof Error ? err.message : "생성하지 못했습니다.");
    }
  };

  return (
    <Grid>
      <Column sm={4} md={8} lg={{ span: 10, offset: 3 }}>
        <Stack gap={6}>
          <div>
            <Link to="/" className="cds--link">
              ← 내 서브도메인
            </Link>
            <h1 className="cds--type-heading-05 page-title-tight">새 서브도메인</h1>
          </div>

          {limitReached && (
            <InlineNotification
              kind="warning"
              title="한도에 도달했습니다"
              subtitle={`1인당 최대 ${me.limits.max}개까지 사용할 수 있습니다. 사용하지 않는 서브도메인을 반납한 뒤 다시 시도하세요.`}
              hideCloseButton
              lowContrast
            />
          )}

          <ProgressIndicator currentIndex={step} spaceEqually className="steps">
            {STEPS.map((label, i) => (
              <ProgressStep key={label} label={label} complete={i < step} current={i === step} />
            ))}
          </ProgressIndicator>

          {step === 0 && (
            <Stack gap={5}>
              <TextInput
                id="lease-name"
                labelText="서브도메인 이름"
                placeholder="alice"
                value={rawName}
                maxLength={32}
                autoComplete="off"
                invalid={nameMessage.invalid}
                invalidText={nameMessage.text}
                helperText={nameMessage.invalid ? undefined : nameMessage.text}
                onChange={(e) => setRawName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && nameReady && setStep(1)}
              />
              <ButtonSet>
                <Button kind="secondary" onClick={() => navigate("/")}>
                  취소
                </Button>
                <Button disabled={!nameReady || limitReached} onClick={() => setStep(1)}>
                  다음
                </Button>
              </ButtonSet>
            </Stack>
          )}

          {step === 1 && (
            <Stack gap={5}>
              <TileGroup legend="어디에 연결하나요?" name="target-kind" valueSelected={kind ?? undefined} onChange={(v) => setKind(v as TargetKind)}>
                {TARGET_KINDS.map((k) => (
                  <RadioTile key={k} id={`kind-${k}`} value={k} className="kind-tile">
                    <strong>{KIND_DESCRIPTIONS[k].title}</strong>
                    <p className="cds--type-body-compact-01 kind-desc">{KIND_DESCRIPTIONS[k].body}</p>
                  </RadioTile>
                ))}
              </TileGroup>
              <ButtonSet>
                <Button kind="secondary" onClick={() => setStep(0)}>
                  이전
                </Button>
                <Button
                  disabled={!kind}
                  onClick={() => {
                    setErrors(NO_ERRORS);
                    setStep(2);
                  }}
                >
                  다음
                </Button>
              </ButtonSet>
            </Stack>
          )}

          {step === 2 && kind && form && (
            <Stack gap={5}>
              <p>
                <span className="mono">{name}.{zone}</span> → {KIND_DESCRIPTIONS[kind].title}
              </p>
              <RecordsEditor kind={kind} name={name} zone={zone} form={form} errors={errors} onChange={(f) => setForms({ ...forms, [kind]: f })} />
              <ButtonSet>
                <Button kind="secondary" onClick={() => setStep(1)}>
                  이전
                </Button>
                <Button onClick={goRecords}>다음</Button>
              </ButtonSet>
            </Stack>
          )}

          {step === 3 && kind && preview && (
            <Stack gap={5}>
              <p>
                다음 DNS 레코드를 <strong className="mono">{zone}</strong> 존에 만듭니다. 대여 기간이 끝나기 전에 목록이나 상세 화면에서 연장할 수 있습니다.
              </p>
              <RecordPreview records={preview.records} label="생성될 레코드" />
              {submitError && <InlineNotification kind="error" title="생성하지 못했습니다" subtitle={submitError} hideCloseButton lowContrast />}
              <ButtonSet>
                <Button kind="secondary" disabled={submitting} onClick={() => setStep(2)}>
                  이전
                </Button>
                {submitting ? (
                  <InlineLoading description="생성 중…" className="inline-loading-btn" />
                ) : (
                  <Button disabled={limitReached} onClick={() => void submit()}>
                    생성
                  </Button>
                )}
              </ButtonSet>
            </Stack>
          )}
        </Stack>
      </Column>
    </Grid>
  );
}
