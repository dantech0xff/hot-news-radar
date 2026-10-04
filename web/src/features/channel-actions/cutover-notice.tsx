/**
 * Shown while a cutover channel has no `notBefore` (see `isCutoverPending`):
 * the server refuses Resume, Run now, and output retries until the cutover
 * instant is saved, so only articles published after it can be posted.
 */

import { Link } from 'react-router';

import { IconAlert } from '../../components/icons';
import { Notice } from '../../components/states';
import { cn } from '../../lib/cn';
import { cutoverSectionPath } from '../../lib/operations';

export const CUTOVER_NOTICE_TITLE = 'Cần đặt mốc cutover trước khi kênh đăng bài';
export const CUTOVER_BLOCKS_RESUME = 'Cần đặt mốc cutover (notBefore) trước khi resume';
export const CUTOVER_BLOCKS_RUN = 'Cần đặt mốc cutover (notBefore) trước khi chạy';
export const CUTOVER_BLOCKS_RETRY = 'Cần đặt mốc cutover (notBefore) trước khi gửi lại';

const LINK_LABEL = 'Đặt mốc cutover';

export function CutoverNotice({ channelId, compact = false, className }: { channelId: string; compact?: boolean; className?: string }) {
  const link = (
    <Link to={cutoverSectionPath(channelId)} className="font-medium underline underline-offset-2 hover:no-underline">
      {LINK_LABEL}
    </Link>
  );
  if (compact) {
    return (
      <p className={cn('mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-800', className)}>
        <IconAlert className="size-3.5 shrink-0" />
        <span className="font-semibold">{CUTOVER_NOTICE_TITLE}.</span>
        <span>Resume và Chạy ngay đang bị khoá.</span>
        {link}
      </p>
    );
  }
  return (
    <Notice tone="danger" title={CUTOVER_NOTICE_TITLE} className={className}>
      <p>
        Kênh này tiếp quản việc đăng bài từ một hệ thống khác. Resume, Chạy ngay và Gửi lại bị khoá cho tới khi
        đặt mốc cutover (notBefore), để chỉ bài publish sau mốc này mới được đăng. Preview vẫn dùng được vì không gửi bài.
      </p>
      <p>{link}</p>
    </Notice>
  );
}
