import { InlineNotification, Modal, Stack, TextInput } from "@carbon/react";
import { useEffect, useState } from "react";

interface WithdrawModalProps {
  open: boolean;
  email: string;
  liveLeases: number;
  onClose: () => void;
  /** 실패하면 Error를 던진다 */
  onConfirm: () => Promise<void>;
}

/** 회원 탈퇴 확인. 이메일을 직접 입력해야 버튼이 활성화된다. */
export function WithdrawModal({ open, email, liveLeases, onClose, onConfirm }: WithdrawModalProps) {
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

  const matches = typed.trim().toLowerCase() === email;
  const submit = async () => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "탈퇴하지 못했습니다.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      danger
      modalHeading="회원 탈퇴"
      primaryButtonText={busy ? "처리 중…" : "탈퇴"}
      secondaryButtonText="취소"
      primaryButtonDisabled={!matches || busy}
      onRequestClose={() => !busy && onClose()}
      onRequestSubmit={() => void submit()}
      preventCloseOnClickOutside
    >
      <Stack gap={5}>
        <p>
          회원 정보를 삭제합니다. 사용 중·일시 중지 상태의 서브도메인 {liveLeases}개는 DNS 레코드를 지우고 반납하며, 연결된 사이트는 곧바로 접속되지
          않습니다. 반납한 이름은 일정 기간 다른 사람이 신청할 수 없고, 이 작업은 되돌릴 수 없습니다.
        </p>
        <p>보안과 남용 대응을 위해 감사 로그(이메일, IP, 작업 기록)와 서브도메인 기록(이메일, 이름, DNS 레코드 내용)은 삭제되지 않고 남습니다. 다시 로그인해도 예전 서브도메인은 보이지 않습니다.</p>
        <TextInput
          id="withdraw-confirm"
          labelText={`확인을 위해 이메일(${email})을 입력하세요`}
          value={typed}
          autoComplete="off"
          onChange={(e) => setTyped(e.target.value)}
          data-modal-primary-focus
        />
        {error && <InlineNotification kind="error" title="탈퇴하지 못했습니다" subtitle={error} hideCloseButton lowContrast />}
      </Stack>
    </Modal>
  );
}
