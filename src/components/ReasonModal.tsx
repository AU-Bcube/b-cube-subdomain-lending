import { InlineNotification, Modal, Stack, TextArea } from "@carbon/react";
import { useEffect, useState, type ReactNode } from "react";

interface ReasonModalProps {
  open: boolean;
  heading: string;
  primaryText: string;
  danger?: boolean;
  /** true이면 사유를 입력해야 확인 버튼이 활성화된다 */
  required?: boolean;
  children?: ReactNode;
  onClose: () => void;
  /** 실패하면 오류 메시지를 담은 Error를 던진다 */
  onSubmit: (reason: string) => Promise<void>;
}

export function ReasonModal({ open, heading, primaryText, danger, required = true, children, onClose, onSubmit }: ReasonModalProps) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const trimmed = reason.trim();
  const submit = async () => {
    if (submitting || (required && !trimmed)) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "요청이 실패했습니다.");
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      danger={danger}
      modalHeading={heading}
      primaryButtonText={submitting ? "처리 중…" : primaryText}
      secondaryButtonText="취소"
      primaryButtonDisabled={submitting || (required && !trimmed)}
      onRequestClose={() => !submitting && onClose()}
      onRequestSubmit={() => void submit()}
      preventCloseOnClickOutside
    >
      <Stack gap={5}>
        {children}
        <TextArea
          id="reason-modal-text"
          labelText={required ? "사유 (필수)" : "사유 (선택)"}
          placeholder="감사 로그에 기록됩니다."
          value={reason}
          maxCount={500}
          enableCounter
          rows={3}
          onChange={(e) => setReason(e.target.value)}
          data-modal-primary-focus
        />
        {error && <InlineNotification kind="error" title="처리하지 못했습니다" subtitle={error} hideCloseButton lowContrast />}
      </Stack>
    </Modal>
  );
}
