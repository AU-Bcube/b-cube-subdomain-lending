import { Pagination } from "@carbon/react";

interface KoPaginationProps {
  page: number;
  pageSize: number;
  totalItems: number;
  onChange: (page: number) => void;
}

/** 페이지 크기는 서버가 정한다. 페이지 번호만 바꾼다. */
export function KoPagination({ page, pageSize, totalItems, onChange }: KoPaginationProps) {
  return (
    <Pagination
      page={page}
      pageSize={pageSize}
      pageSizes={[pageSize]}
      pageSizeInputDisabled
      totalItems={totalItems}
      backwardText="이전 페이지"
      forwardText="다음 페이지"
      itemsPerPageText="페이지당"
      itemRangeText={(min, max, total) => `${total}개 중 ${min}–${max}`}
      pageRangeText={(_current, total) => `/ ${total} 페이지`}
      pageSelectLabelText={(total) => `페이지 선택 (전체 ${total})`}
      onChange={({ page: next }) => onChange(next)}
    />
  );
}
