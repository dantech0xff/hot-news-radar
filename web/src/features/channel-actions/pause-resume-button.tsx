import { useState } from 'react';

import type { ChannelStatus } from '../../api/types';
import { IconPause, IconPlay } from '../../components/icons';
import { OperatorButton } from '../../components/operator-button';
import { Notice } from '../../components/states';
import { isCutoverPending } from '../../lib/operations';
import { ControlDialog, type ControlRequest } from './control-dialog';
import { CUTOVER_BLOCKS_RESUME } from './cutover-notice';

/**
 * Pause or Resume (whichever applies) with a confirmation dialog.
 * `expectedVersion` is the delivery-state `version` from the channel status.
 * Resume stays disabled while the channel waits for its cutover instant;
 * pausing is always possible.
 */
export function PauseResumeButton({ channelId, channelName, status, size = 'sm' }: {
  channelId: string;
  channelName: string;
  status: ChannelStatus | undefined;
  size?: 'sm' | 'md';
}) {
  const [request, setRequest] = useState<ControlRequest | null>(null);
  const paused = status?.paused === true;
  const version = status?.version ?? null;
  const unavailable = !status
    ? 'Đang tải trạng thái kênh'
    : status.paused === null || version === null ? 'Kênh chưa có trạng thái giao hàng'
    : paused && isCutoverPending(status) ? CUTOVER_BLOCKS_RESUME : null;

  const open = () => {
    if (!status || version === null) return;
    setRequest({ channelId, action: paused ? 'resume' : 'pause', expectedVersion: version });
  };

  return (
    <>
      <OperatorButton
        size={size}
        variant={paused ? 'primary' : 'secondary'}
        icon={paused ? <IconPlay className="size-3.5" /> : <IconPause className="size-3.5" />}
        disabledReason={unavailable}
        onClick={open}
      >
        {paused ? 'Resume' : 'Pause'}
      </OperatorButton>
      {request ? (
        <ControlDialog
          request={request}
          tone={request.action === 'pause' ? 'danger' : 'primary'}
          title={request.action === 'pause' ? `Pause kênh ${channelName}?` : `Resume kênh ${channelName}?`}
          description={request.action === 'pause'
            ? 'Kênh ngừng nhận lượt đăng mới. Lượt gửi đang diễn ra không bị huỷ.'
            : 'Kênh bắt đầu chạy theo lịch và đăng bài lên Telegram.'}
          confirmLabel={request.action === 'pause' ? 'Pause kênh' : 'Resume kênh'}
          successMessage={() => (request.action === 'pause' ? `Đã pause kênh ${channelName}.` : `Đã resume kênh ${channelName}.`)}
          onClose={() => setRequest(null)}
        >
          {request.action === 'resume' ? (
            <Notice tone="warning" title="Kiểm tra trước khi resume">
              <p>Kênh cần đủ credential (Telegram bot token, chat ID và khoá AI) nếu không máy chủ sẽ từ chối.</p>
              <p>Không để cùng một chat Telegram được đăng đồng thời từ hai hệ thống (dashboard này và hệ thống khác).</p>
            </Notice>
          ) : null}
        </ControlDialog>
      ) : null}
    </>
  );
}
