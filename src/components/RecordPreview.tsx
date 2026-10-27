import { StructuredListBody, StructuredListCell, StructuredListHead, StructuredListRow, StructuredListWrapper, Tag } from "@carbon/react";

interface PreviewRecord {
  type: string;
  host: string;
  content: string;
  proxied: boolean;
  /** false이면 Cloudflare에 없는 레코드 (suspended 등) */
  live?: boolean;
}

export function RecordPreview({ records, label = "DNS 레코드" }: { records: readonly PreviewRecord[]; label?: string }) {
  return (
    <div className="table-scroll table-scroll--narrow">
      <StructuredListWrapper aria-label={label} isCondensed>
        <StructuredListHead>
          <StructuredListRow head>
            <StructuredListCell head>타입</StructuredListCell>
            <StructuredListCell head>호스트</StructuredListCell>
            <StructuredListCell head>값</StructuredListCell>
            <StructuredListCell head>프록시</StructuredListCell>
          </StructuredListRow>
        </StructuredListHead>
        <StructuredListBody>
          {records.map((r, i) => (
            <StructuredListRow key={`${r.type}-${r.host}-${r.content}-${i}`}>
              <StructuredListCell>{r.type}</StructuredListCell>
              <StructuredListCell className="mono break">{r.host}</StructuredListCell>
              <StructuredListCell className="mono break">
                {r.content}
                {r.live === false && (
                  <Tag type="gray" size="sm" className="inline-tag">
                    DNS에서 제거됨
                  </Tag>
                )}
              </StructuredListCell>
              <StructuredListCell>{r.proxied ? "켬" : "끔"}</StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
    </div>
  );
}
