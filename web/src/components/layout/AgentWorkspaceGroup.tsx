import { useEffect, useId, useState } from 'react';
import { Bot, ChevronRight, MoreHorizontal, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const COLLAPSED_AGENTS_KEY = 'miniclaw:collapsed-agent-sections';

function readCollapsedAgents(): Set<string> {
  try {
    const value = JSON.parse(
      localStorage.getItem(COLLAPSED_AGENTS_KEY) || '[]',
    );
    return new Set(
      Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

function persistAgentState(agentId: string, collapsed: boolean) {
  try {
    const ids = readCollapsedAgents();
    if (collapsed) ids.add(agentId);
    else ids.delete(agentId);
    localStorage.setItem(COLLAPSED_AGENTS_KEY, JSON.stringify([...ids]));
  } catch {
    // Private browsing or hardened policies may disable persistent storage.
  }
}

interface AgentWorkspaceGroupProps {
  agentId: string;
  name: string;
  collapsible?: boolean;
  workspaceCount: number;
  workspaceNames?: string[];
  runningCount?: number;
  isDirectActive?: boolean;
  containsActiveWorkspace?: boolean;
  onSelect: () => void;
  onRebuild?: () => void;
  children: React.ReactNode;
}

export function AgentWorkspaceGroup({
  agentId,
  name,
  collapsible = true,
  workspaceCount,
  workspaceNames = [],
  runningCount = 0,
  isDirectActive = false,
  containsActiveWorkspace = false,
  onSelect,
  onRebuild,
  children,
}: AgentWorkspaceGroupProps) {
  const contentId = useId();
  const [storedExpanded, setStoredExpanded] = useState(
    () => containsActiveWorkspace || !readCollapsedAgents().has(agentId),
  );
  const expanded = !collapsible || storedExpanded;

  useEffect(() => {
    if (collapsible && containsActiveWorkspace) setStoredExpanded(true);
  }, [collapsible, containsActiveWorkspace]);

  const toggle = () => {
    if (!collapsible) return;
    const nextExpanded = !expanded;
    setStoredExpanded(nextExpanded);
    persistAgentState(agentId, !nextExpanded);
  };

  return (
    <section
      className="mb-1"
      data-hc-agent-group={agentId}
      data-collapsible={collapsible ? 'true' : 'false'}
    >
      <div
        className={cn(
          'group flex min-h-12 w-full items-center rounded-xl border border-transparent transition-[background-color,border-color] hover:border-border/70 hover:bg-accent/50',
          isDirectActive &&
            'border-primary/15 bg-primary/7 shadow-sm dark:bg-primary/10',
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-current={isDirectActive ? 'page' : undefined}
          className="flex min-h-12 min-w-0 flex-1 items-center rounded-xl px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground group-hover:bg-background group-hover:text-primary">
              <Bot className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold leading-5 text-foreground">
                {name}
              </span>
              {!expanded && workspaceNames.length > 0 && (
                <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                  {workspaceNames.slice(0, 2).join(' · ')}
                  {workspaceNames.length > 2
                    ? ` +${workspaceNames.length - 2}`
                    : ''}
                </span>
              )}
            </span>
          </span>
          {expanded && workspaceCount > 0 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {workspaceCount}
            </span>
          )}
          {runningCount > 0 && (
            <span
              className="mr-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
              title={`${runningCount} 个工作区运行中`}
            />
          )}
        </button>
        {collapsible && (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            aria-controls={contentId}
            aria-label={`${expanded ? '收起' : '展开'} ${name} 的工作区`}
            className="grid min-h-9 min-w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
          >
            <ChevronRight
              className={cn(
                'h-4 w-4 transition-transform duration-200',
                expanded && 'rotate-90',
              )}
            />
          </button>
        )}
        {onRebuild && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(event) => event.stopPropagation()}
                className="mr-1 grid min-h-8 min-w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                title={`${name}的更多操作`}
                aria-label={`${name}的更多操作`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem
                onClick={onRebuild}
                className="min-h-9 gap-2 text-amber-700 transition-[background-color,box-shadow] duration-150 hover:bg-amber-50 hover:text-amber-700 hover:shadow-md focus:text-amber-700 focus:shadow-md data-[highlighted]:bg-amber-50 data-[highlighted]:shadow-md dark:text-amber-400 dark:hover:bg-amber-950/30 dark:hover:text-amber-400 dark:focus:text-amber-400 dark:data-[highlighted]:bg-amber-950/30"
              >
                <RotateCcw className="h-4 w-4" />
                重建工作区
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div
        id={contentId}
        aria-hidden={!expanded}
        inert={!expanded}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="py-0.5">{children}</div>
        </div>
      </div>
    </section>
  );
}
