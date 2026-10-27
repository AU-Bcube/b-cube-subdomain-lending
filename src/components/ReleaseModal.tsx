import { InlineNotification, Modal, Stack, TextInput } from "@carbon/react";
import { useEffect, useState } from "react";

interface ReleaseModalProps {
  open: boolean;
  name: string;
  fqdn: string;
  onClose: () => void;
  /** 실패하면 Error를 던진다 */
  onConfirm: () => Promise<void>;
}

/** 반납 확인. 이름을 직접 입력해야 버튼이 활성화된다 (SPEC §11). */
export function ReleaseModal({ open, name, fqdn, onClose, onConfirm }: ReleaseModalProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTyped("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const matches = typed.trim() === name;
  const submit = async () => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "반납하지 못했습니다.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      danger
      modalHeading="서브도메인 반납"
      primaryButtonText={busy ? "반납 중…" : "반납"}
      secondaryButtonText="취소"
      primaryButtonDisabled={!matches || busy}
      onRequestClose={() => !busy && onClose()}
      onRequestSubmit={() => void submit()}
      preventCloseOnClickOutside
    >
      <Stack gap={5}>
        <p>
          <strong className="mono">{fqdn}</strong>의 DNS 레코드를 삭제하고 반납합니다. 연결된 사이트는 곧바로 접속되지 않습니다. 반납한 이름은
          일정 기간 본인만 다시 신청할 수 있습니다.
        </p>
        <TextInput
          id="release-confirm"
          labelText={`확인을 위해 이름(${name})을 입력하세요`}
          value={typed}
          autoComplete="off"
          onChange={(e) => setTyped(e.target.value)}
          data-modal-primary-focus
        />
        {error && <InlineNotification kind="error" title="반납하지 못했습니다" subtitle={error} hideCloseButton lowContrast />}
      </Stack>
    </Modal>
  );
}
