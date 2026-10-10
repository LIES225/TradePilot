import { memo } from 'react';
import { MoreHorizontal, Pencil, Trash2, RotateCcw, Pin } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useAuthStore } from '../../stores/auth';

export interface ChatGroupItemProps {
  jid: string;
  name: string;
  folder: string;
  lastMessage?: string;

  isActive: boolean;
  isHome: boolean;
  isPinned?: boolean;
  isRunning?: boolean;
  // Owner-only ACL (backend buildGroupsPayload 下发的 can_modify)，门控所有破坏性操作
  canModify?: boolean;
  onSelect: (jid: string, folder: string) => void;
  onRename?: (jid: string, name: string) => void;
  onClearHistory: (jid: string, name: string) => void;
  onDelete?: (jid: string, name: string) => void;
  onTogglePin?: (jid: string) => void;
}

function ChatGroupItemComponent({
  jid,
  name,
  folder,
  lastMessage,
  isActive,
  isHome,
  isPinned,
  isRunning,
  canModify,
  onSelect,
  onRename,
  onClearHistory,
  onDelete,
  onTogglePin,
}: ChatGroupItemProps) {
  const currentUser = useAuthStore((s) => s.user);
  const defaultHomeName = '我的工作区';
  // Use actual name if it's been renamed, otherwise fall back to default
  const isDefaultName =
    !name || name === 'Main' || name === `${currentUser?.username} Home`;
  const displayName = isHome && isDefaultName ? defaultHomeName : name;
  const messagePreview = lastMessage?.replace(/\s+/g, ' ').trim();
  return (
    <div
      className={cn(
        'group relative mb-1 rounded-xl border border-transparent transition-[background-color,border-color,box-shadow]',
        isActive
          ? 'border-primary/15 bg-primary/8 text-foreground shadow-sm dark:bg-primary/10'
          : 'text-foreground hover:border-border/80 hover:bg-accent/55',
      )}
    >
      <button
        onClick={() => onSelect(jid, folder)}
        aria-current={isActive ? 'page' : undefined}
        className="flex min-h-[3.5rem] w-full items-center gap-2.5 rounded-xl px-3 pr-10 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      >
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            isRunning
              ? 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.13)]'
              : isActive
                ? 'bg-primary'
                : 'bg-border',
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">
              {displayName}
            </span>
            {isPinned && !isHome && (
              <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">
            {messagePreview || (isRunning ? '正在处理请求…' : '暂无消息')}
          </span>
        </span>
      </button>

      {/* Dropdown menu */}
      <div
        className={cn(
          'absolute right-2 top-1/2 -translate-y-1/2 flex items-center',
          'opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity',
        )}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={(e) => e.stopPropagation()}
              title={`${displayName}的更多操作`}
              aria-label={`${displayName}的更多操作`}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {!isHome && onTogglePin && (
              <DropdownMenuItem onClick={() => onTogglePin(jid)}>
                <Pin className="w-4 h-4" />
                {isPinned ? '取消固定' : '固定'}
              </DropdownMenuItem>
            )}
            {canModify && onRename && (
              <DropdownMenuItem onClick={() => onRename(jid, name)}>
                <Pencil className="w-4 h-4" />
                重命名
              </DropdownMenuItem>
            )}
            {canModify && (
              <DropdownMenuItem
                onClick={() => onClearHistory(jid, displayName)}
                className="text-amber-700 dark:text-amber-400 focus:text-amber-700 dark:focus:text-amber-400"
              >
                <RotateCcw className="w-4 h-4" />
                重建工作区
              </DropdownMenuItem>
            )}
            {!isHome && canModify && onDelete && (
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDelete(jid, name)}
              >
                <Trash2 className="w-4 h-4" />
                删除
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// Parent layout state (for example, another workspace entering a running
// state) should not repaint every row in a long conversation list. Actions
// are stable store/navigation callbacks; render only when this row's visible
// data changes.
export const ChatGroupItem = memo(
  ChatGroupItemComponent,
  (previous, next) =>
    previous.jid === next.jid &&
    previous.name === next.name &&
    previous.folder === next.folder &&
    previous.lastMessage === next.lastMessage &&
    previous.isActive === next.isActive &&
    previous.isHome === next.isHome &&
    previous.isPinned === next.isPinned &&
    previous.isRunning === next.isRunning &&
    previous.canModify === next.canModify,
);
